use firecrawl::{
    AlexandriaCall, AlexandriaOptions, Client, FirecrawlError, SearchOptions, SearchSource,
};
use mockito::Matcher;
use serde_json::json;

#[tokio::test]
async fn unified_contracts_and_execution_identity() {
    let mut server = mockito::Server::new_async().await;
    let tool = json!({"id":"p/a","provider":"p","capability":"a","name":"Tool","description":"Example","creditsCost":2,"perRecord":false,"options":[{"name":"q","type":"string"}],"response":{"fields":[]},"examples":{},"matchedBy":["semantic","domain"],"matchedUrls":["https://example.com"]});
    let production_tool = json!({"id":"benzinga/calendar/ratings","provider":"benzinga","capability":"calendar/ratings","name":"Analyst ratings","description":"Ratings","creditsCost":5,"perRecord":false,"label":"Ratings","whenToUse":"Analyst ratings for a ticker","returns":{"about":"Ratings"},"discovery":{"urls":[]},"attribution":{"required":true},"options":[{"name":"tickers","type":"string"}],"response":{"fields":[]},"matchedBy":["semantic"],"matchedUrls":[]});
    let search = server
        .mock("POST", "/v2/search")
        .match_body(Matcher::PartialJson(
            json!({"query":"tools","sources":["alexandria"],"domainTools":true}),
        ))
        .with_header("content-type", "application/json")
        .with_body(
            json!({"success":true,"data":{"tools":[tool.clone(), production_tool.clone()]}})
                .to_string(),
        )
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
    let tools = found.data.tools.as_ref().unwrap();
    assert_eq!(serde_json::to_value(&tools[0]).unwrap(), tool);
    assert!(tools[1].examples.is_empty());
    assert_eq!(tools[1].label.as_deref(), Some("Ratings"));
    assert_eq!(
        tools[1].when_to_use.as_deref(),
        Some("Analyst ratings for a ticker")
    );
    assert_eq!(tools[1].matched_by, vec!["semantic"]);
    search.assert_async().await;
    let terms = server
        .mock("POST", "/v2/scrape")
        .match_header("x-request-id", "terms-1")
        .with_status(403)
        .with_header("content-type", "application/json")
        .with_body(
            r#"{"success":false,"code":"THIRD_PARTY_DATA_TERMS_REQUIRED","error":"An organization admin must accept the benzinga provider's terms","requiresAction":{"type":"accept_terms","terms":"benzinga","version":"C-1.0.0-draft","url":"https://www.firecrawl.dev/app/alexandria/benzinga"}}"#,
        )
        .create_async()
        .await;
    match client
        .scrape_alexandria(
            vec![AlexandriaCall {
                provider: "benzinga".into(),
                capability: "calendar/ratings".into(),
                options: None,
            }],
            AlexandriaOptions {
                request_id: Some("terms-1".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err()
    {
        FirecrawlError::AlexandriaExecution { request_id, source } => {
            assert_eq!(request_id, "terms-1");
            match *source {
                FirecrawlError::APIError(_, error) => {
                    assert_eq!(
                        error.code.as_deref(),
                        Some("THIRD_PARTY_DATA_TERMS_REQUIRED")
                    );
                    let action = error.requires_action.expect("requires_action");
                    assert_eq!(action.kind, "accept_terms");
                    assert_eq!(action.terms.as_deref(), Some("benzinga"));
                    assert_eq!(action.version.as_deref(), Some("C-1.0.0-draft"));
                    assert_eq!(
                        action.url.as_deref(),
                        Some("https://www.firecrawl.dev/app/alexandria/benzinga")
                    );
                }
                _ => panic!("missing terms API error"),
            }
        }
        _ => panic!("missing terms execution identity"),
    }
    terms.assert_async().await;
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
