//! Attribute macro backing `scrape_url::kinded`. See that module for what the
//! generated code is for.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::{format_ident, quote};
use syn::{
  Error, Expr, ExprArray, ExprLit, Fields, Ident, ItemEnum, Lit, Meta, Token, Type,
  parse_macro_input, punctuated::Punctuated,
};

/// Turns an enum into a `Kinded` tagged union: derives its discriminant enum,
/// implements `Kinded` and `Deserialize`, and hangs typed option accessors off
/// its `KindedSet`.
///
/// ```ignore
/// #[kinded(noun = "format", default = [Markdown])]
/// #[derive(Debug, Clone, PartialEq, Eq)]
/// pub enum Format {
///   Markdown,                     // no options
///   Screenshot(ScreenshotOptions) // options, accessible as `.screenshot()`
/// }
/// ```
///
/// Arguments: `noun` (required) is the singular name used in error messages,
/// `default` (optional) lists the variants a set holds when the user specifies
/// none, and `kind` (optional) names the discriminant enum, defaulting to
/// `{Enum}Kind`.
#[proc_macro_attribute]
pub fn kinded(args: TokenStream, input: TokenStream) -> TokenStream {
  let args = parse_macro_input!(args with Punctuated::<Meta, Token![,]>::parse_terminated);
  let item = parse_macro_input!(input as ItemEnum);

  expand(args, item)
    .unwrap_or_else(Error::into_compile_error)
    .into()
}

struct Options {
  variant: Ident,
  ty: Type,
  accessor: Ident,
}

fn expand(args: Punctuated<Meta, Token![,]>, item: ItemEnum) -> Result<TokenStream2, Error> {
  let mut noun: Option<String> = None;
  let mut defaults: Vec<Ident> = Vec::with_capacity(0);
  let mut kind: Option<Ident> = None;

  for arg in &args {
    let Meta::NameValue(arg) = arg else {
      return Err(Error::new_spanned(arg, "expected `name = value`"));
    };

    match arg.path.require_ident()?.to_string().as_str() {
      "noun" => {
        let Expr::Lit(ExprLit {
          lit: Lit::Str(value),
          ..
        }) = &arg.value
        else {
          return Err(Error::new_spanned(
            &arg.value,
            "`noun` must be a string literal",
          ));
        };

        noun = Some(value.value());
      }

      "default" => {
        let Expr::Array(ExprArray { elems, .. }) = &arg.value else {
          return Err(Error::new_spanned(
            &arg.value,
            "`default` must be an array of variant names",
          ));
        };

        for elem in elems {
          let Expr::Path(elem) = elem else {
            return Err(Error::new_spanned(elem, "expected a variant name"));
          };

          defaults.push(elem.path.require_ident()?.clone());
        }
      }

      "kind" => {
        let Expr::Path(value) = &arg.value else {
          return Err(Error::new_spanned(
            &arg.value,
            "`kind` must be an identifier",
          ));
        };

        kind = Some(value.path.require_ident()?.clone());
      }

      _ => {
        return Err(Error::new_spanned(
          &arg.path,
          "unknown argument, expected `noun`, `default`, or `kind`",
        ));
      }
    }
  }

  let Some(noun) = noun else {
    return Err(Error::new_spanned(
      &item.ident,
      "`noun` is required, e.g. #[kinded(noun = \"format\")]",
    ));
  };

  let name = item.ident.clone();
  let kind = kind.unwrap_or_else(|| format_ident!("{}Kind", name));

  let mut units: Vec<Ident> = Vec::new();
  let mut options: Vec<Options> = Vec::new();

  for variant in &item.variants {
    match &variant.fields {
      Fields::Unit => units.push(variant.ident.clone()),

      Fields::Unnamed(fields) if fields.unnamed.len() == 1 => options.push(Options {
        variant: variant.ident.clone(),
        ty: fields.unnamed[0].ty.clone(),
        accessor: format_ident!(
          "{}",
          snake_case(&variant.ident.to_string()),
          span = variant.ident.span()
        ),
      }),

      _ => {
        return Err(Error::new_spanned(
          variant,
          "kinded variants must either take no fields, or be a tuple variant holding exactly one options struct",
        ));
      }
    }
  }

  let default_members = defaults
    .iter()
    .map(|default| {
      if units.contains(default) {
        Ok(quote!(#name::#default))
      } else if options.iter().any(|x| &x.variant == default) {
        Ok(quote!(#name::#default(Default::default())))
      } else {
        Err(Error::new_spanned(
          default,
          format!("`{}` is not a variant of `{}`", default, name),
        ))
      }
    })
    .collect::<Result<Vec<_>, _>>()?;

  let option_variants = options.iter().map(|x| &x.variant).collect::<Vec<_>>();
  let option_types = options.iter().map(|x| &x.ty).collect::<Vec<_>>();
  let option_accessors = options.iter().map(|x| &x.accessor).collect::<Vec<_>>();

  Ok(quote! {
    #[derive(strum::EnumDiscriminants)]
    #[strum_discriminants(
      name(#kind),
      derive(
        Hash,
        PartialOrd,
        Ord,
        strum::Display,
        strum::EnumIter,
        strum::EnumString
      ),
      strum(serialize_all = "camelCase")
    )]
    #item

    impl crate::scrape_url::kinded::Kinded for #name {
      type Kind = #kind;

      const NOUN: &'static str = #noun;

      fn kind(&self) -> #kind {
        #kind::from(self)
      }

      fn from_kind_with_options(
        kind: #kind,
        options: ::serde_json::Map<String, ::serde_json::Value>,
      ) -> Result<Self, ::serde_json::Error> {
        Ok(match kind {
          #(#kind::#units => {
            if !options.is_empty() {
              return Err(<::serde_json::Error as ::serde::de::Error>::custom(format!(
                concat!(#noun, " {} does not take any options, but got: {}"),
                #kind::#units,
                options.keys().cloned().collect::<Vec<String>>().join(", "),
              )));
            }

            #name::#units
          },)*
          #(#kind::#option_variants => #name::#option_variants(
            ::serde_json::from_value(::serde_json::Value::Object(options))?
          ),)*
        })
      }

      fn default_members() -> Vec<Self> {
        vec![#(#default_members),*]
      }
    }

    impl<'de> ::serde::Deserialize<'de> for #name {
      fn deserialize<D: ::serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        crate::scrape_url::kinded::deserialize_kinded(deserializer)
      }
    }

    impl crate::scrape_url::kinded::KindedSet<#name> {
      #(
        pub fn #option_accessors(&self) -> Option<&#option_types> {
          match self.get(#kind::#option_variants) {
            Some(#name::#option_variants(options)) => Some(options),
            _ => None,
          }
        }
      )*
    }
  })
}

fn snake_case(pascal: &str) -> String {
  let mut out = String::with_capacity(pascal.len() + 4);

  for (i, char) in pascal.char_indices() {
    if char.is_uppercase() {
      if i != 0 {
        out.push('_');
      }

      out.extend(char.to_lowercase());
    } else {
      out.push(char);
    }
  }

  out
}
