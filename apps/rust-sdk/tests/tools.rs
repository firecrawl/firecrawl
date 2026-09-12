use firecrawl::{
    Client, AlexandriaCall, AlexandriaOptions, FirecrawlError, SearchOptions, SearchSource,
};
use mockito::Matcher;
use serde_json::json;

#[tokio::test]
async fn unified_contracts_and_execution_identity() {
    let mut server = mockito::Server::new_async().await;
    let tool = json!({"id":"p/a","provider":"p","capability":"a","name":"Tool","description":"Example","creditsCost":2,"perRecord":false,"options":[{"name":"q","type":"string"}],"response":{"fields":[]},"examples":{},"matchedBy":["semantic","domain"],"matchedUrls":["https://example.com"]});
    let search = server
        .mock("POST", "/v2/search")
        .match_body(Matcher::PartialJson(
            json!({"query":"tools","sources":["alexandria"],"domainTools":true}),
        ))
        .with_header("content-type", "application/json")
        .with_body(json!({"success":true,"data":{"tools":[tool.clone()]}}).to_string())
        .create_async()
        .await;
    let client = Client::new_selfhosted(server.url(), Some("fc-test")).unwrap();
    let found = client
        .search(
            "tools",
            SearchOptions {
                sources: Some(vec![SearchSource::Alexandria]),
                domain_tools: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&found.data.tools.as_ref().unwrap()[0]).unwrap(),
        tool
    );
    search.assert_async().await;
    let denied = server
        .mock("POST", "/v2/scrape")
        .match_header("x-request-id", "denied-1")
        .match_body(Matcher::PartialJson(
            json!({"alexandria":[{"provider":"p","capability":"a"}]}),
        ))
        .with_status(402)
        .with_header("content-type", "application/json")
        .with_body(
            r#"{"success":false,"error":"Insufficient credits","code":"insufficient_credits"}"#,
        )
        .create_async()
        .await;
    let error = client
        .scrape_alexandria(
            vec![AlexandriaCall {
                provider: "p".into(),
                capability: "a".into(),
                options: None,
            }],
            AlexandriaOptions {
                request_id: Some("denied-1".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    match error {
        FirecrawlError::AlexandriaExecution { request_id, source } => {
            assert_eq!(request_id, "denied-1");
            assert!(matches!(*source, FirecrawlError::APIError(_, _)));
        }
        _ => panic!("missing execution identity"),
    }
    denied.assert_async().await;
    assert!(matches!(
        client.search("   ", None).await,
        Err(FirecrawlError::Misuse(_))
    ));
    let invalid = server.mock("POST", "/v2/scrape")
        .with_header("content-type", "application/json")
        .with_body(r#"{"success":true,"scrape_id":"s1","data":{"alexandria":[{"error":{"code":"invalid_options","message":"Invalid lookup"}}],"creditsCost":0}}"#)
        .create_async().await;
    match client.find_tools(None).await.unwrap_err() {
        FirecrawlError::AlexandriaExecution { request_id, source } => {
            assert!(!request_id.is_empty());
            match *source {
                FirecrawlError::APIError(_, error) => {
                    assert_eq!(error.code.as_deref(), Some("invalid_options"))
                }
                _ => panic!("missing lookup error code"),
            }
        }
        _ => panic!("missing lookup request ID"),
    }
    invalid.assert_async().await;
}
