use hegel::TestCase;
use hegel::generators as gs;

use crate::{
  Encoding, TokenizerError, cache, count_tokens, fit_to_tokens, fit_to_tokens_with_chunk_size,
  trim_to_token_limit,
};

const ALL_ENCODING_MODELS: [&str; 6] = [
  "gpt-4o",
  "gpt-4",
  "text-davinci-003",
  "text-davinci-edit-001",
  "davinci",
  "gpt2",
];

#[hegel::test]
fn arbitrary_utf8_never_panics_and_satisfies_invariants(tc: TestCase) {
  let input = tc.draw(gs::text());
  let model_idx = tc.draw(gs::integers::<usize>().min_value(0).max_value(5));
  let max_tokens = tc.draw(gs::integers::<usize>().min_value(0).max_value(256));
  let model = *ALL_ENCODING_MODELS.get(model_idx).unwrap_or(&"gpt-4o");

  match count_tokens(&input, model) {
    Ok(count) => {
      assert!(count <= input.len());
      assert_eq!(count == 0, input.is_empty());

      let trimmed = trim_to_token_limit(&input, max_tokens, model);
      assert!(trimmed.is_ok());
      let fitted = fit_to_tokens(&input, max_tokens, model);
      assert!(fitted.is_ok());

      if let (Ok(trimmed), Ok(fitted)) = (trimmed, fitted) {
        assert_eq!(trimmed.original_tokens, count);
        assert_eq!(fitted.trimmed, trimmed.trimmed);
        assert_eq!(fitted.text, trimmed.text);

        if count <= max_tokens {
          assert!(!trimmed.trimmed);
          assert_eq!(trimmed.text, input);
          assert_eq!(trimmed.num_tokens, count);
        } else {
          assert!(trimmed.trimmed);
          assert_eq!(trimmed.num_tokens, max_tokens);
          // Re-counting holds whenever lossy UTF-8 replacement did not expand
          // a split multi-byte sequence into a 3-byte U+FFFD trailer.
          if !fitted.text.ends_with('\u{FFFD}') {
            assert!(matches!(
              count_tokens(&fitted.text, model),
              Ok(tokens) if tokens <= max_tokens
            ));
          }
        }
      }
    }
    Err(TokenizerError::DisallowedSpecialToken(_)) => {
      assert!(matches!(
        trim_to_token_limit(&input, max_tokens, model),
        Err(TokenizerError::DisallowedSpecialToken(_))
      ));
      assert!(matches!(
        fit_to_tokens(&input, max_tokens, model),
        Err(TokenizerError::DisallowedSpecialToken(_))
      ));
    }
    Err(other) => {
      assert!(
        matches!(other, TokenizerError::DisallowedSpecialToken(_)),
        "unexpected error for known model {model}: {other}"
      );
    }
  }

  let unknown = tc.draw(gs::text());
  if Encoding::from_model(&unknown).is_err() {
    assert!(matches!(
      count_tokens(&input, &unknown),
      Err(TokenizerError::UnknownModel(_))
    ));
    assert!(matches!(
      trim_to_token_limit(&input, max_tokens, &unknown),
      Err(TokenizerError::UnknownModel(_))
    ));
    assert!(matches!(
      fit_to_tokens(&input, max_tokens, &unknown),
      Err(TokenizerError::UnknownModel(_))
    ));
  }
}

#[hegel::test]
fn roundtrip_and_trim_idempotence(tc: TestCase) {
  let input = tc.draw(gs::text());
  let model_idx = tc.draw(gs::integers::<usize>().min_value(0).max_value(5));
  let max_tokens = tc.draw(gs::integers::<usize>().min_value(0).max_value(128));
  let model = *ALL_ENCODING_MODELS.get(model_idx).unwrap_or(&"gpt-4o");

  let encoding = Encoding::from_model(model);
  assert!(encoding.is_ok());
  if let Ok(encoding) = encoding {
    let bpe = cache::encoder(encoding);
    assert!(bpe.is_ok());
    if let Ok(bpe) = bpe {
      let tokens = bpe.encode(&input);
      assert_eq!(bpe.decode(&tokens), input.as_bytes());
      assert_eq!(bpe.count(&input), tokens.len());
    }
  }

  if let Ok(first) = trim_to_token_limit(&input, max_tokens, model) {
    // When the token cut does not split a multi-byte UTF-8 sequence into U+FFFD,
    // re-trimming to the same budget must be a no-op with identical token count.
    if !first.text.ends_with('\u{FFFD}')
      && let Ok(second) = trim_to_token_limit(&first.text, max_tokens, model)
    {
      assert!(!second.trimmed);
      assert_eq!(second.text, first.text);
      assert_eq!(second.num_tokens, first.num_tokens);
    }
  }
}

#[hegel::test]
fn chunked_fit_matches_full_trim_for_arbitrary_utf8(tc: TestCase) {
  let input = tc.draw(gs::text());
  let max_tokens = tc.draw(gs::integers::<usize>().min_value(0).max_value(120));
  let chunk_bytes = tc.draw(gs::integers::<usize>().min_value(1).max_value(64));
  let model_idx = tc.draw(gs::integers::<usize>().min_value(0).max_value(5));
  let model = *ALL_ENCODING_MODELS.get(model_idx).unwrap_or(&"gpt-4o");

  let full = trim_to_token_limit(&input, max_tokens, model);
  let chunked = fit_to_tokens_with_chunk_size(&input, max_tokens, model, chunk_bytes);

  assert_eq!(
    chunked.map(|c| (c.trimmed, c.text)),
    full.map(|f| (f.trimmed, f.text))
  );
}

#[hegel::test]
fn disallowed_special_tokens_are_rejected_including_after_budget(tc: TestCase) {
  let prefix = tc.draw(gs::from_regex("[a-z ]{0,48}"));
  let suffix = tc.draw(gs::from_regex("[a-z ]{0,48}"));
  let model_idx = tc.draw(gs::integers::<usize>().min_value(0).max_value(5));
  let model = *ALL_ENCODING_MODELS.get(model_idx).unwrap_or(&"gpt-4o");

  let encoding = Encoding::from_model(model);
  assert!(encoding.is_ok());
  if let Ok(encoding) = encoding {
    let specials = encoding.disallowed_special_tokens();
    let spec_idx = tc.draw(
      gs::integers::<usize>()
        .min_value(0)
        .max_value(specials.len().saturating_sub(1)),
    );
    let special = *specials.get(spec_idx).unwrap_or(&"<|endoftext|>");

    let text = format!("{prefix}{special}{suffix}");
    assert_eq!(
      count_tokens(&text, model),
      Err(TokenizerError::DisallowedSpecialToken(special))
    );
    assert_eq!(
      trim_to_token_limit(&text, 1_000, model),
      Err(TokenizerError::DisallowedSpecialToken(special))
    );
    assert_eq!(
      fit_to_tokens(&text, 1_000, model),
      Err(TokenizerError::DisallowedSpecialToken(special))
    );

    // Reject even when max_tokens would otherwise early-exit before the special token.
    let chunk_size = prefix.len().saturating_add(4).max(8);
    assert_eq!(
      fit_to_tokens_with_chunk_size(&text, 1, model, chunk_size),
      Err(TokenizerError::DisallowedSpecialToken(special))
    );
  }
}

#[test]
fn split_multibyte_utf8_replaces_trailing_fragment_with_fffd() {
  // Four-byte emoji encodes into multiple byte-level tokens in cl100k_base.
  let emoji = "👋";
  let count = count_tokens(emoji, "gpt-4");
  assert!(count.is_ok());
  if let Ok(count) = count {
    assert!(count >= 2);
    let trimmed = trim_to_token_limit(emoji, 1, "gpt-4");
    assert!(trimmed.is_ok());
    if let Ok(trimmed) = trimmed {
      assert!(trimmed.trimmed);
      assert_eq!(trimmed.num_tokens, 1);
      assert_eq!(trimmed.original_tokens, count);
      assert_eq!(trimmed.text, "\u{FFFD}");
    }
  }
}

#[test]
fn resolves_configured_openai_models_and_rejects_non_openai() {
  assert_eq!(Encoding::from_model("gpt2"), Ok(Encoding::Gpt2));
  assert_eq!(Encoding::from_model("gpt-2"), Ok(Encoding::Gpt2));
  assert_eq!(
    Encoding::from_model("gpt-4o-realtime-preview"),
    Ok(Encoding::O200kBase)
  );
  assert_eq!(
    Encoding::from_model("gpt-4o-realtime-preview-2025-06-03"),
    Ok(Encoding::O200kBase)
  );
  assert_eq!(Encoding::from_model("gpt-5-chat"), Ok(Encoding::O200kBase));
  assert_eq!(
    Encoding::from_model("gpt-5-chat-latest"),
    Ok(Encoding::O200kBase)
  );
  assert_eq!(Encoding::from_model("o3-pro"), Ok(Encoding::O200kBase));
  assert_eq!(
    Encoding::from_model("gpt-4-1106-vision-preview"),
    Ok(Encoding::Cl100kBase)
  );
  assert_eq!(
    Encoding::from_model("gpt-35-turbo"),
    Ok(Encoding::Cl100kBase)
  );
  assert_eq!(
    Encoding::from_model("ft:gpt-4o:org::123"),
    Ok(Encoding::O200kBase)
  );
  assert_eq!(
    Encoding::from_model("ft:gpt-4-0613:org::123"),
    Ok(Encoding::Cl100kBase)
  );

  assert!(Encoding::from_model("claude-3-5-sonnet").is_err());
  assert!(Encoding::from_model("gemini-2.5-flash").is_err());
  assert!(Encoding::from_model("").is_err());
  assert!(Encoding::from_model("ft:").is_err());
}

#[test]
fn delimiter_free_long_input_matches_full_trim() {
  let blob = ".".repeat(200_000);
  let full = trim_to_token_limit(&blob, 500, "gpt-4o");
  let fitted = fit_to_tokens(&blob, 500, "gpt-4o");
  assert!(full.is_ok());
  assert!(fitted.is_ok());
  if let (Ok(full), Ok(fitted)) = (full, fitted) {
    assert_eq!(fitted.trimmed, full.trimmed);
    assert_eq!(fitted.text, full.text);
  }
}
