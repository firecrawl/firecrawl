use firecrawl::{AgentOptions, AuditMetadata, MapOptions, ParseOptions, ScrapeOptions};
use serde::Serialize;

fn assert_audit_metadata<T: Serialize>(options: T) {
    let value = serde_json::to_value(options).expect("options should serialize");
    assert_eq!(value["auditMetadata"]["username"], "alice@example.com");
}

#[test]
fn serializes_audit_metadata_across_request_options() {
    let metadata = AuditMetadata {
        username: "alice@example.com".to_string(),
    };

    assert_audit_metadata(ScrapeOptions {
        audit_metadata: Some(metadata.clone()),
        ..Default::default()
    });
    assert_audit_metadata(MapOptions {
        audit_metadata: Some(metadata.clone()),
        ..Default::default()
    });
    assert_audit_metadata(AgentOptions {
        prompt: "find pricing".to_string(),
        audit_metadata: Some(metadata.clone()),
        ..Default::default()
    });
    assert_audit_metadata(ParseOptions {
        audit_metadata: Some(metadata),
        ..Default::default()
    });
}
