//! shottino's C binding over vodozemac: the native twin of cicchetto's
//! wasm binding (`cicchetto/wasm/vodozemac-binding/src/lib.rs`).
//!
//! The surface is the same one, function for function, so the two clients
//! drive one Olm the same way; a slice that needs more of vodozemac adds it
//! to BOTH. Keys and signatures cross as vodozemac prints them: standard
//! base64, unpadded. The C declarations are `include/vodozemac.h`.
//!
//! Conventions, the same for every function:
//! - Handles are opaque `Box` pointers, freed by their `vz_*_free`. A
//!   function documented as CONSUMING a handle frees it, failed or not.
//! - A returned `char *` is a NUL-terminated UTF-8 string owned by the
//!   caller, freed with `vz_str_free`; a returned `vz_buf` with
//!   `vz_buf_free`.
//! - Failure is NULL (or -1), and `vz_last_error()` says why, on the
//!   calling thread. Nothing panics across the boundary: every entry point
//!   catches an unwind and reports it as an error, because a panic in a
//!   terminal client is a dead terminal.

use std::cell::RefCell;
use std::ffi::{CStr, CString, c_char};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use sha2::{Digest, Sha256};
use vodozemac::ecies::{
    Ecies as VEcies, EstablishedEcies as VEstablishedEcies, InitialMessage, Message as EciesMessage,
};
use vodozemac::hpke::DigitMode;
use vodozemac::olm::{
    Account as OlmAccount, AccountPickle, OlmMessage, PreKeyMessage, Session as OlmSession, SessionConfig,
    SessionPickle,
};
use vodozemac::sas::{EstablishedSas as VEstablishedSas, Sas as VSas};
use vodozemac::{Curve25519PublicKey, Ed25519PublicKey, Ed25519Signature, base64_decode, base64_encode};

// ── Errors ───────────────────────────────────────────────────────────────

thread_local! {
    static LAST_ERROR: RefCell<CString> = RefCell::new(CString::default());
}

fn set_error(message: &str) {
    let message = CString::new(message.replace('\0', " ")).unwrap_or_default();
    LAST_ERROR.with(|e| *e.borrow_mut() = message);
}

/// Why the last call on this thread failed; "" when nothing has. Valid
/// until the next call on this thread.
#[unsafe(no_mangle)]
pub extern "C" fn vz_last_error() -> *const c_char {
    LAST_ERROR.with(|e| e.borrow().as_ptr())
}

/// Runs `f`, turning an `Err` or a panic into `fail` and a recorded error.
fn guard<T>(fail: T, f: impl FnOnce() -> Result<T, String>) -> T {
    set_error("");
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            set_error(&e);
            fail
        }
        Err(_) => {
            set_error("vodozemac panicked");
            fail
        }
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ── Values across the boundary ───────────────────────────────────────────

/// Bytes owned by the caller; free with `vz_buf_free`.
#[repr(C)]
pub struct VzBuf {
    pub ptr: *mut u8,
    pub len: usize,
}

impl VzBuf {
    fn empty() -> VzBuf {
        VzBuf { ptr: ptr::null_mut(), len: 0 }
    }

    fn from_vec(v: Vec<u8>) -> VzBuf {
        let mut b = v.into_boxed_slice();
        let out = VzBuf { ptr: b.as_mut_ptr(), len: b.len() };
        std::mem::forget(b);
        out
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_buf_free(buf: VzBuf) {
    if buf.ptr.is_null() {
        return;
    }
    // SAFETY: every non-null VzBuf was made by `from_vec` from a boxed slice
    // of exactly this length.
    unsafe { drop(Box::from_raw(ptr::slice_from_raw_parts_mut(buf.ptr, buf.len))) };
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_str_free(s: *mut c_char) {
    if !s.is_null() {
        // SAFETY: every string handed out was made by `out_str`.
        unsafe { drop(CString::from_raw(s)) };
    }
}

fn out_str(s: String) -> *mut c_char {
    CString::new(s).map(CString::into_raw).unwrap_or(ptr::null_mut())
}

fn in_str<'a>(s: *const c_char) -> Result<&'a str, String> {
    if s.is_null() {
        return Err("a NULL string".into());
    }
    // SAFETY: the caller passes a NUL-terminated string that outlives the call.
    unsafe { CStr::from_ptr(s) }.to_str().map_err(err)
}

fn in_bytes<'a>(p: *const u8, n: usize) -> Result<&'a [u8], String> {
    if n == 0 {
        return Ok(&[]);
    }
    if p.is_null() {
        return Err("NULL bytes".into());
    }
    // SAFETY: the caller passes `n` readable bytes that outlive the call.
    Ok(unsafe { std::slice::from_raw_parts(p, n) })
}

fn boxed<T>(v: T) -> *mut T {
    Box::into_raw(Box::new(v))
}

fn handle<'a, T>(p: *const T) -> Result<&'a T, String> {
    // SAFETY: a non-null handle came from `boxed` and is not yet freed.
    unsafe { p.as_ref() }.ok_or_else(|| "a NULL handle".to_string())
}

fn handle_mut<'a, T>(p: *mut T) -> Result<&'a mut T, String> {
    // SAFETY: as `handle`, and the caller holds the only reference.
    unsafe { p.as_mut() }.ok_or_else(|| "a NULL handle".to_string())
}

fn take<T>(p: *mut T) -> Result<T, String> {
    if p.is_null() {
        return Err("a NULL handle".into());
    }
    // SAFETY: a non-null handle came from `boxed`; it is consumed here.
    Ok(*unsafe { Box::from_raw(p) })
}

fn free<T>(p: *mut T) {
    if !p.is_null() {
        // SAFETY: as `take`.
        unsafe { drop(Box::from_raw(p)) };
    }
}

// A key from the wire, as its 32 bytes. Checked here, never by vodozemac:
// its `from_base64` accepts any 44-character input and PANICS when that
// decodes to 33 bytes (0.10, still so in 0.11.1). Same guard as cicchetto's.
fn key_bytes(key: &str) -> Result<[u8; 32], String> {
    let bytes = base64_decode(key.trim_end_matches('=')).map_err(err)?;
    bytes.try_into().map_err(|_| "a key is 32 bytes".to_string())
}

fn ed25519(key: &str) -> Result<Ed25519PublicKey, String> {
    Ed25519PublicKey::from_slice(&key_bytes(key)?).map_err(err)
}

fn curve25519(key: &str) -> Result<Curve25519PublicKey, String> {
    Ok(Curve25519PublicKey::from_bytes(key_bytes(key)?))
}

// ── Account ──────────────────────────────────────────────────────────────

pub struct VzAccount(OlmAccount);

#[unsafe(no_mangle)]
pub extern "C" fn vz_account_new() -> *mut VzAccount {
    guard(ptr::null_mut(), || Ok(boxed(VzAccount(OlmAccount::new()))))
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_account_from_pickle(json: *const c_char) -> *mut VzAccount {
    guard(ptr::null_mut(), || {
        let pickle: AccountPickle = serde_json::from_str(in_str(json)?).map_err(err)?;
        Ok(boxed(VzAccount(OlmAccount::from_pickle(pickle))))
    })
}

/// The whole account, private keys included, as JSON. The caller encrypts
/// it before it is stored anywhere.
#[unsafe(no_mangle)]
pub extern "C" fn vz_account_pickle(a: *const VzAccount) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_str(serde_json::to_string(&handle(a)?.0.pickle()).map_err(err)?)))
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_account_free(a: *mut VzAccount) {
    free(a)
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_account_ed25519_key(a: *const VzAccount) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_str(handle(a)?.0.ed25519_key().to_base64())))
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_account_curve25519_key(a: *const VzAccount) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_str(handle(a)?.0.curve25519_key().to_base64())))
}

/// Signs `message` (as UTF-8) with the Ed25519 identity key.
#[unsafe(no_mangle)]
pub extern "C" fn vz_account_sign(a: *const VzAccount, message: *const c_char) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_str(handle(a)?.0.sign(in_str(message)?).to_base64())))
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_account_max_one_time_keys(a: *const VzAccount) -> usize {
    guard(0, || Ok(handle(a)?.0.max_number_of_one_time_keys()))
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_account_generate_one_time_keys(a: *mut VzAccount, count: usize) -> i32 {
    guard(-1, || {
        handle_mut(a)?.0.generate_one_time_keys(count);
        Ok(0)
    })
}

/// The one-time keys not yet marked as published, oldest first, as a JSON
/// array of strings.
#[unsafe(no_mangle)]
pub extern "C" fn vz_account_one_time_keys(a: *const VzAccount) -> *mut c_char {
    guard(ptr::null_mut(), || {
        let mut keys: Vec<_> = handle(a)?.0.one_time_keys().into_iter().collect();
        keys.sort_by_key(|(id, _)| *id);
        let keys: Vec<String> = keys.into_iter().map(|(_, k)| k.to_base64()).collect();
        Ok(out_str(serde_json::to_string(&keys).map_err(err)?))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_account_generate_fallback_key(a: *mut VzAccount) -> i32 {
    guard(-1, || {
        handle_mut(a)?.0.generate_fallback_key();
        Ok(0)
    })
}

/// The fallback key if it is not yet marked as published; NULL with an
/// EMPTY `vz_last_error()` when there is none.
#[unsafe(no_mangle)]
pub extern "C" fn vz_account_fallback_key(a: *const VzAccount) -> *mut c_char {
    guard(ptr::null_mut(), || {
        Ok(handle(a)?.0.fallback_key().into_values().next().map_or(ptr::null_mut(), |k| out_str(k.to_base64())))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_account_mark_keys_as_published(a: *mut VzAccount) -> i32 {
    guard(-1, || {
        handle_mut(a)?.0.mark_keys_as_published();
        Ok(0)
    })
}

pub struct VzSession(OlmSession);

/// Opens a session to a peer from its Curve25519 identity key and one of
/// its one-time (or fallback) keys.
#[unsafe(no_mangle)]
pub extern "C" fn vz_account_create_outbound_session(
    a: *const VzAccount,
    identity_key: *const c_char,
    one_time_key: *const c_char,
) -> *mut VzSession {
    guard(ptr::null_mut(), || {
        let s = handle(a)?
            .0
            .create_outbound_session(
                SessionConfig::version_1(),
                curve25519(in_str(identity_key)?)?,
                curve25519(in_str(one_time_key)?)?,
            )
            .map_err(err)?;
        Ok(boxed(VzSession(s)))
    })
}

/// Opens the session a peer started with a pre-key message (its bytes) and
/// decrypts that first message into `plaintext`. Uses up the one-time key
/// it was built on: store the account afterwards.
#[unsafe(no_mangle)]
pub extern "C" fn vz_account_create_inbound_session(
    a: *mut VzAccount,
    identity_key: *const c_char,
    message: *const u8,
    message_len: usize,
    plaintext: *mut VzBuf,
) -> *mut VzSession {
    guard(ptr::null_mut(), || {
        let out = handle_mut(plaintext)?;
        *out = VzBuf::empty();
        let m = PreKeyMessage::from_bytes(in_bytes(message, message_len)?).map_err(err)?;
        let created = handle_mut(a)?
            .0
            .create_inbound_session(SessionConfig::version_1(), curve25519(in_str(identity_key)?)?, &m)
            .map_err(err)?;
        *out = VzBuf::from_vec(created.plaintext);
        Ok(boxed(VzSession(created.session)))
    })
}

// ── Session ──────────────────────────────────────────────────────────────

#[unsafe(no_mangle)]
pub extern "C" fn vz_session_from_pickle(json: *const c_char) -> *mut VzSession {
    guard(ptr::null_mut(), || {
        let pickle: SessionPickle = serde_json::from_str(in_str(json)?).map_err(err)?;
        Ok(boxed(VzSession(OlmSession::from_pickle(pickle))))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_session_pickle(s: *const VzSession) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_str(serde_json::to_string(&handle(s)?.0.pickle()).map_err(err)?)))
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_session_free(s: *mut VzSession) {
    free(s)
}

/// The id both ends compute; a pre-key message names the same one.
#[unsafe(no_mangle)]
pub extern "C" fn vz_session_id(s: *const VzSession) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_str(handle(s)?.0.session_id())))
}

/// 1 once this session has decrypted a message from the peer, 0 before,
/// -1 on a bad handle. Until then `vz_session_encrypt` yields pre-key
/// messages.
#[unsafe(no_mangle)]
pub extern "C" fn vz_session_has_received_message(s: *const VzSession) -> i32 {
    guard(-1, || Ok(i32::from(handle(s)?.0.has_received_message())))
}

/// Encrypts `plaintext`: `*message_type` 0 for a pre-key message (PKMSG),
/// 1 for a normal one (MSG), and the message bytes in `body`.
#[unsafe(no_mangle)]
pub extern "C" fn vz_session_encrypt(
    s: *mut VzSession,
    plaintext: *const u8,
    plaintext_len: usize,
    message_type: *mut usize,
    body: *mut VzBuf,
) -> i32 {
    guard(-1, || {
        let out = handle_mut(body)?;
        *out = VzBuf::empty();
        let t = handle_mut(message_type)?;
        let (mt, bytes) = handle_mut(s)?.0.encrypt(in_bytes(plaintext, plaintext_len)?).map_err(err)?.to_parts();
        *t = mt;
        *out = VzBuf::from_vec(bytes);
        Ok(0)
    })
}

/// Decrypts a message of `message_type` (0 pre-key, 1 normal) from its bytes.
#[unsafe(no_mangle)]
pub extern "C" fn vz_session_decrypt(
    s: *mut VzSession,
    message_type: usize,
    body: *const u8,
    body_len: usize,
    plaintext: *mut VzBuf,
) -> i32 {
    guard(-1, || {
        let out = handle_mut(plaintext)?;
        *out = VzBuf::empty();
        let m = OlmMessage::from_parts(message_type, in_bytes(body, body_len)?).map_err(err)?;
        *out = VzBuf::from_vec(handle_mut(s)?.0.decrypt(&m).map_err(err)?);
        Ok(0)
    })
}

// ── SAS ──────────────────────────────────────────────────────────────────

pub struct VzSas(VSas);
pub struct VzEstablishedSas(VEstablishedSas);

#[unsafe(no_mangle)]
pub extern "C" fn vz_sas_new() -> *mut VzSas {
    guard(ptr::null_mut(), || Ok(boxed(VzSas(VSas::new()))))
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_sas_public_key(s: *const VzSas) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_str(handle(s)?.0.public_key().to_base64())))
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_sas_free(s: *mut VzSas) {
    free(s)
}

/// The shared secret with the peer's public half. CONSUMES `s`.
#[unsafe(no_mangle)]
pub extern "C" fn vz_sas_diffie_hellman(s: *mut VzSas, their_key: *const c_char) -> *mut VzEstablishedSas {
    guard(ptr::null_mut(), || {
        let sas = take(s)?;
        Ok(boxed(VzEstablishedSas(sas.0.diffie_hellman(curve25519(in_str(their_key)?)?).map_err(err)?)))
    })
}

/// The 7 emoji, as indices into the Matrix SAS emoji table, into `out`.
#[unsafe(no_mangle)]
pub extern "C" fn vz_established_sas_emoji_indices(
    s: *const VzEstablishedSas,
    info: *const c_char,
    out: *mut u8,
) -> i32 {
    guard(-1, || {
        if out.is_null() {
            return Err("NULL output".into());
        }
        let indices = handle(s)?.0.bytes(in_str(info)?).emoji_indices();
        // SAFETY: the caller passes room for 7 bytes.
        unsafe { ptr::copy_nonoverlapping(indices.as_ptr(), out, 7) };
        Ok(0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_established_sas_calculate_mac(
    s: *const VzEstablishedSas,
    input: *const c_char,
    info: *const c_char,
) -> *mut c_char {
    guard(ptr::null_mut(), || {
        Ok(out_str(handle(s)?.0.calculate_mac(in_str(input)?, in_str(info)?).to_base64()))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_established_sas_free(s: *mut VzEstablishedSas) {
    free(s)
}

// ── ECIES (MSC4108 shape) ────────────────────────────────────────────────

pub struct VzEcies(VEcies);
pub struct VzEstablishedEcies(VEstablishedEcies);

#[unsafe(no_mangle)]
pub extern "C" fn vz_ecies_new(info: *const c_char) -> *mut VzEcies {
    guard(ptr::null_mut(), || Ok(boxed(VzEcies(VEcies::with_info(in_str(info)?)))))
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_ecies_public_key(e: *const VzEcies) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_str(handle(e)?.0.public_key().to_base64())))
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_ecies_free(e: *mut VzEcies) {
    free(e)
}

/// Opens a channel to `their_key` with `plaintext` as the first message,
/// whose encoding lands in `*message`. CONSUMES `e`.
#[unsafe(no_mangle)]
pub extern "C" fn vz_ecies_establish_outbound(
    e: *mut VzEcies,
    their_key: *const c_char,
    plaintext: *const u8,
    plaintext_len: usize,
    message: *mut *mut c_char,
) -> *mut VzEstablishedEcies {
    guard(ptr::null_mut(), || {
        let ecies = take(e)?;
        let out = handle_mut(message)?;
        *out = ptr::null_mut();
        let created = ecies
            .0
            .establish_outbound_channel(curve25519(in_str(their_key)?)?, in_bytes(plaintext, plaintext_len)?)
            .map_err(err)?;
        *out = out_str(created.message.encode());
        Ok(boxed(VzEstablishedEcies(created.ecies)))
    })
}

/// Accepts the other side's initial message. CONSUMES `e`.
#[unsafe(no_mangle)]
pub extern "C" fn vz_ecies_establish_inbound(
    e: *mut VzEcies,
    initial: *const c_char,
    plaintext: *mut VzBuf,
) -> *mut VzEstablishedEcies {
    guard(ptr::null_mut(), || {
        let ecies = take(e)?;
        let out = handle_mut(plaintext)?;
        *out = VzBuf::empty();
        let m = InitialMessage::decode(in_str(initial)?).map_err(err)?;
        let created = ecies.0.establish_inbound_channel(&m).map_err(err)?;
        *out = VzBuf::from_vec(created.message);
        Ok(boxed(VzEstablishedEcies(created.ecies)))
    })
}

/// The two-digit check code, 0 to 99 (render it with two digits); -1 on a
/// bad handle.
#[unsafe(no_mangle)]
pub extern "C" fn vz_established_ecies_check_code(e: *const VzEstablishedEcies) -> i32 {
    guard(-1, || Ok(i32::from(handle(e)?.0.check_code().to_digit(DigitMode::AllowLeadingZero))))
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_established_ecies_encrypt(
    e: *mut VzEstablishedEcies,
    plaintext: *const u8,
    plaintext_len: usize,
) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_str(handle_mut(e)?.0.encrypt(in_bytes(plaintext, plaintext_len)?).encode())))
}

/// Decrypts a message from the other side's encrypt. Each message is read
/// once and in order.
#[unsafe(no_mangle)]
pub extern "C" fn vz_established_ecies_decrypt(
    e: *mut VzEstablishedEcies,
    message: *const c_char,
    plaintext: *mut VzBuf,
) -> i32 {
    guard(-1, || {
        let out = handle_mut(plaintext)?;
        *out = VzBuf::empty();
        let m = EciesMessage::decode(in_str(message)?).map_err(err)?;
        *out = VzBuf::from_vec(handle_mut(e)?.0.decrypt(&m).map_err(err)?);
        Ok(0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vz_established_ecies_free(e: *mut VzEstablishedEcies) {
    free(e)
}

// ── Free functions ───────────────────────────────────────────────────────

/// The session id a pre-key message (as bytes) belongs to.
#[unsafe(no_mangle)]
pub extern "C" fn vz_pre_key_session_id(message: *const u8, message_len: usize) -> *mut c_char {
    guard(ptr::null_mut(), || {
        Ok(out_str(PreKeyMessage::from_bytes(in_bytes(message, message_len)?).map_err(err)?.session_id()))
    })
}

/// 1 when `signature` is `key`'s Ed25519 signature over `message` (UTF-8),
/// 0 otherwise — including for anything malformed: a key or signature off
/// the wire is never a reason to fail louder than "no".
#[unsafe(no_mangle)]
pub extern "C" fn vz_verify_ed25519(key: *const c_char, message: *const c_char, signature: *const c_char) -> i32 {
    guard(0, || {
        let Ok(key) = ed25519(in_str(key)?) else { return Ok(0) };
        let Ok(sig) = Ed25519Signature::from_base64(in_str(signature)?) else { return Ok(0) };
        Ok(i32::from(key.verify(in_str(message)?.as_bytes(), &sig).is_ok()))
    })
}

/// SHA-256 of `data` into `out` (32 bytes).
#[unsafe(no_mangle)]
pub extern "C" fn vz_sha256(data: *const u8, data_len: usize, out: *mut u8) -> i32 {
    guard(-1, || {
        if out.is_null() {
            return Err("NULL output".into());
        }
        let digest = Sha256::digest(in_bytes(data, data_len)?);
        // SAFETY: the caller passes room for 32 bytes.
        unsafe { ptr::copy_nonoverlapping(digest.as_ptr(), out, 32) };
        Ok(0)
    })
}

/// The one spelling of an Ed25519 key: vodozemac's unpadded base64.
#[unsafe(no_mangle)]
pub extern "C" fn vz_canonical_ed25519(key: *const c_char) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_str(ed25519(in_str(key)?)?.to_base64())))
}

/// The one spelling of a Curve25519 key: vodozemac's unpadded base64.
#[unsafe(no_mangle)]
pub extern "C" fn vz_canonical_curve25519(key: *const c_char) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_str(curve25519(in_str(key)?)?.to_base64())))
}

/// Standard base64, unpadded — the encoding every key, signature and Olm
/// body on this wire uses.
#[unsafe(no_mangle)]
pub extern "C" fn vz_base64_encode(data: *const u8, data_len: usize) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_str(base64_encode(in_bytes(data, data_len)?))))
}

/// Decodes standard base64 (padding tolerated) into `out`.
#[unsafe(no_mangle)]
pub extern "C" fn vz_base64_decode(text: *const c_char, out: *mut VzBuf) -> i32 {
    guard(-1, || {
        let o = handle_mut(out)?;
        *o = VzBuf::empty();
        *o = VzBuf::from_vec(base64_decode(in_str(text)?.trim_end_matches('=')).map_err(err)?);
        Ok(0)
    })
}
