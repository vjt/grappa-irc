//! The thin wasm-bindgen binding cicchetto uses over vodozemac (issue 2430).
//!
//! It exposes what cicchetto calls and nothing more; a later slice that
//! needs more of vodozemac adds it here and rebuilds the vendored artifact
//! (`scripts/wasm.sh`). Keys and signatures cross as vodozemac prints them:
//! standard base64, unpadded.

use vodozemac::olm::{Account as OlmAccount, AccountPickle};
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
}
