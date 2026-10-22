//! The thin wasm-bindgen binding cicchetto uses over vodozemac (issue 2430).
//!
//! It exposes what cicchetto calls and nothing more; a later slice that
//! needs more of vodozemac adds it here and rebuilds the vendored artifact
//! (`scripts/wasm.sh`). Keys and signatures cross as vodozemac prints them:
//! standard base64, unpadded.

use vodozemac::olm::{
    Account as OlmAccount, AccountPickle, OlmMessage, PreKeyMessage, Session as OlmSession, SessionConfig,
    SessionPickle,
};
use vodozemac::{Curve25519PublicKey, Ed25519PublicKey, Ed25519Signature, base64_decode};
use wasm_bindgen::prelude::*;

/// An Olm account: the identity keys, the one-time keys and the fallback key.
#[wasm_bindgen]
pub struct Account(OlmAccount);

#[wasm_bindgen]
impl Account {
    /// A new account with fresh identity keys and no one-time keys.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Account {
        Account(OlmAccount::new())
    }

    /// Restores an account from what `pickle` returned.
    pub fn from_pickle(pickle: &str) -> Result<Account, JsError> {
        let pickle: AccountPickle = serde_json::from_str(pickle).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Account(OlmAccount::from_pickle(pickle)))
    }

    /// The whole account, private keys included, as JSON. The caller
    /// encrypts it before it is stored anywhere.
    pub fn pickle(&self) -> String {
        serde_json::to_string(&self.0.pickle()).expect("an account pickle always serialises")
    }

    /// The Ed25519 identity key: what a peer pins.
    pub fn ed25519_key(&self) -> String {
        self.0.ed25519_key().to_base64()
    }

    /// The Curve25519 identity key.
    pub fn curve25519_key(&self) -> String {
        self.0.curve25519_key().to_base64()
    }

    /// Signs `message` (as UTF-8) with the Ed25519 identity key.
    pub fn sign(&self, message: &str) -> String {
        self.0.sign(message).to_base64()
    }

    /// The most one-time keys a server should hold for this account.
    pub fn max_number_of_one_time_keys(&self) -> usize {
        self.0.max_number_of_one_time_keys()
    }

    /// Generates `count` one-time keys, unpublished.
    pub fn generate_one_time_keys(&mut self, count: usize) {
        self.0.generate_one_time_keys(count);
    }

    /// The one-time keys not yet marked as published, oldest first.
    pub fn one_time_keys(&self) -> Vec<String> {
        let mut keys: Vec<_> = self.0.one_time_keys().into_iter().collect();
        keys.sort_by_key(|(id, _)| *id);
        keys.into_iter().map(|(_, key)| key.to_base64()).collect()
    }

    /// Generates a new fallback key, unpublished; the account keeps the
    /// previous one too, so a session already opened with it still works.
    pub fn generate_fallback_key(&mut self) {
        self.0.generate_fallback_key();
    }

    /// The fallback key if it is not yet marked as published.
    pub fn fallback_key(&self) -> Option<String> {
        self.0.fallback_key().into_values().next().map(|key| key.to_base64())
    }

    /// Marks every unpublished one-time key and the fallback key as published.
    pub fn mark_keys_as_published(&mut self) {
        self.0.mark_keys_as_published();
    }

    /// Opens a session to a peer from its Curve25519 identity key and one of
    /// its one-time (or fallback) keys, as a KEYS answer hands them out.
    pub fn create_outbound_session(&self, identity_key: &str, one_time_key: &str) -> Result<Session, JsError> {
        let session = self
            .0
            .create_outbound_session(SessionConfig::version_1(), curve25519(identity_key)?, curve25519(one_time_key)?)
            .map_err(err)?;
        Ok(Session(session))
    }

    /// Opens the session a peer started with a pre-key message (the body of
    /// a PKMSG, as bytes), and decrypts that first message. Uses up the
    /// one-time key it was built on: store the account afterwards.
    pub fn create_inbound_session(&mut self, identity_key: &str, message: &[u8]) -> Result<InboundSession, JsError> {
        let message = PreKeyMessage::from_bytes(message).map_err(err)?;
        let created = self
            .0
            .create_inbound_session(SessionConfig::version_1(), curve25519(identity_key)?, &message)
            .map_err(err)?;
        Ok(InboundSession { session: Some(Session(created.session)), plaintext: created.plaintext })
    }
}

/// What `Account::create_inbound_session` returns: the session, taken once,
/// and the plaintext of the message that opened it.
#[wasm_bindgen]
pub struct InboundSession {
    session: Option<Session>,
    plaintext: Vec<u8>,
}

#[wasm_bindgen]
impl InboundSession {
    /// The new session; `undefined` once taken.
    pub fn take_session(&mut self) -> Option<Session> {
        self.session.take()
    }

    /// The plaintext of the pre-key message.
    pub fn plaintext(&self) -> Vec<u8> {
        self.plaintext.clone()
    }
}

/// An Olm session with one peer.
#[wasm_bindgen]
pub struct Session(OlmSession);

#[wasm_bindgen]
impl Session {
    /// Restores a session from what `pickle` returned.
    pub fn from_pickle(pickle: &str) -> Result<Session, JsError> {
        let pickle: SessionPickle = serde_json::from_str(pickle).map_err(err)?;
        Ok(Session(OlmSession::from_pickle(pickle)))
    }

    /// The whole session, ratchet keys included, as JSON. The caller
    /// encrypts it before it is stored anywhere.
    pub fn pickle(&self) -> String {
        serde_json::to_string(&self.0.pickle()).expect("a session pickle always serialises")
    }

    /// The id both ends compute for this session; a pre-key message names
    /// the same one (`pre_key_session_id`).
    pub fn session_id(&self) -> String {
        self.0.session_id()
    }

    /// Encrypts `plaintext`: a pre-key message (type 0) until the peer has
    /// answered on this session, a normal message (type 1) after.
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Encrypted, JsError> {
        let (message_type, body) = self.0.encrypt(plaintext).map_err(err)?.to_parts();
        Ok(Encrypted { message_type, body })
    }

    /// Decrypts a message of `message_type` (0 pre-key, 1 normal) from its bytes.
    pub fn decrypt(&mut self, message_type: usize, body: &[u8]) -> Result<Vec<u8>, JsError> {
        let message = OlmMessage::from_parts(message_type, body).map_err(err)?;
        self.0.decrypt(&message).map_err(err)
    }
}

/// An encrypted message: its Olm type and its bytes.
#[wasm_bindgen]
pub struct Encrypted {
    message_type: usize,
    body: Vec<u8>,
}

#[wasm_bindgen]
impl Encrypted {
    /// 0 for a pre-key message (sent as PKMSG), 1 for a normal one (MSG).
    #[wasm_bindgen(getter)]
    pub fn message_type(&self) -> usize {
        self.message_type
    }

    /// The message's bytes.
    #[wasm_bindgen(getter)]
    pub fn body(&self) -> Vec<u8> {
        self.body.clone()
    }
}

/// The session id a pre-key message (as bytes) belongs to.
#[wasm_bindgen]
pub fn pre_key_session_id(message: &[u8]) -> Result<String, JsError> {
    Ok(PreKeyMessage::from_bytes(message).map_err(err)?.session_id())
}

/// Whether `signature` is `key`'s Ed25519 signature over `message` (as
/// UTF-8). False for anything malformed: a key or signature from the wire
/// is never a reason to throw.
#[wasm_bindgen]
pub fn verify_ed25519(key: &str, message: &str, signature: &str) -> bool {
    let Ok(key) = ed25519(key) else { return false };
    let Ok(signature) = Ed25519Signature::from_base64(signature) else { return false };
    key.verify(message.as_bytes(), &signature).is_ok()
}

/// The one spelling of an Ed25519 key: vodozemac's unpadded base64.
#[wasm_bindgen]
pub fn canonical_ed25519(key: &str) -> Result<String, JsError> {
    Ok(ed25519(key)?.to_base64())
}

/// The one spelling of a Curve25519 key: vodozemac's unpadded base64.
#[wasm_bindgen]
pub fn canonical_curve25519(key: &str) -> Result<String, JsError> {
    Ok(curve25519(key)?.to_base64())
}

fn err<E: std::fmt::Display>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

// A key from the wire, as its 32 bytes. Checked here, never by vodozemac:
// its `from_base64` accepts any 44-character input and PANICS when that
// decodes to 33 bytes (0.10, still so in 0.11.1), and a panic in the browser
// is a trap that leaves the module unusable.
fn key_bytes(key: &str) -> Result<[u8; 32], JsError> {
    let bytes = base64_decode(key.trim_end_matches('=')).map_err(err)?;
    bytes.try_into().map_err(|_| JsError::new("a key is 32 bytes"))
}

fn ed25519(key: &str) -> Result<Ed25519PublicKey, JsError> {
    Ed25519PublicKey::from_slice(&key_bytes(key)?).map_err(err)
}

fn curve25519(key: &str) -> Result<Curve25519PublicKey, JsError> {
    Ok(Curve25519PublicKey::from_bytes(key_bytes(key)?))
}
