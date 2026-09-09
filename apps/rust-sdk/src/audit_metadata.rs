use serde::{Deserialize, Serialize};

/// User attribution included with SIEM logging events.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq, Eq)]
pub struct AuditMetadata {
    pub username: String,
}
