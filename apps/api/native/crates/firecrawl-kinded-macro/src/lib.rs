//! Attribute macro backing `firecrawl_core_types::kinded`.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::{format_ident, quote};
use syn::{
  Error, Expr, ExprArray, ExprLit, Fields, Ident, ItemEnum, Lit, Meta, Path, Token, Type,
  parse_macro_input, punctuated::Punctuated,
};

/// Turns an enum into a `Kinded` tagged union: derives its discriminant enum,
/// implements `Kinded`, `Serialize`, `Deserialize`, and `ts_rs::TS`, and hangs
/// typed option accessors off its `KindedSet`.
///
/// Arguments:
/// - `noun` (required): singular name used in deserialization error messages.
/// - `default` (optional): variants a `KindedSet` holds when none are given.
/// - `kind` (optional): discriminant enum name, defaulting to `{Enum}Kind`.
/// - `crate` (optional): path to the `kinded` module, defaulting to
///   `::firecrawl_core_types::kinded`.
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
  let mut defaults: Vec<Ident> = Vec::new();
  let mut kind: Option<Ident> = None;
  let mut kinded_path: Option<Path> = None;

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

      "crate" => {
        let Expr::Path(value) = &arg.value else {
          return Err(Error::new_spanned(
            &arg.value,
            "`crate` must be a module path",
          ));
        };

        kinded_path = Some(value.path.clone());
      }

      _ => {
        return Err(Error::new_spanned(
          &arg.path,
          "unknown argument, expected `noun`, `default`, `kind`, or `crate`",
        ));
      }
    }
  }

  let Some(noun) = noun else {
    return Err(Error::new_spanned(
      &item.ident,
      "`noun` is required, e.g. #[kinded(noun = \"parser\")]",
    ));
  };

  let kinded_mod = match kinded_path {
    Some(path) => quote!(#path),
    None => quote!(::firecrawl_core_types::kinded),
  };

  let name = item.ident.clone();
  let kind = kind.unwrap_or_else(|| format_ident!("{}Kind", name));

  let mut units: Vec<Ident> = Vec::new();
  let mut options: Vec<Options> = Vec::new();
  let mut ts_members: Vec<TokenStream2> = Vec::new();

  for variant in &item.variants {
    let ident = &variant.ident;

    match &variant.fields {
      Fields::Unit => {
        units.push(ident.clone());
        ts_members.push(quote!((#kind::#ident, None)));
      }

      Fields::Unnamed(fields) if fields.unnamed.len() == 1 => {
        let Some(field) = fields.unnamed.first() else {
          return Err(Error::new_spanned(variant, "missing tuple variant field"));
        };
        let ty = &field.ty;
        ts_members.push(quote!((#kind::#ident, Some(<#ty as ::ts_rs::TS>::name(cfg)))));
        options.push(Options {
          variant: ident.clone(),
          ty: ty.clone(),
          accessor: format_ident!("{}", snake_case(&ident.to_string()), span = ident.span()),
        });
      }

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
    #[derive(::strum::EnumDiscriminants)]
    #[strum_discriminants(
      name(#kind),
      derive(
        Hash,
        PartialOrd,
        Ord,
        ::serde::Serialize,
        ::serde::Deserialize,
        ::ts_rs::TS,
        ::strum::Display,
        ::strum::EnumIter,
        ::strum::EnumString
      ),
      serde(rename_all = "camelCase"),
      strum(serialize_all = "camelCase")
    )]
    #item

    impl #kinded_mod::Kinded for #name {
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

    impl ::ts_rs::TS for #name {
      type WithoutGenerics = Self;
      type OptionInnerType = Self;

      fn name(_: &::ts_rs::Config) -> String {
        stringify!(#name).to_owned()
      }

      fn inline(cfg: &::ts_rs::Config) -> String {
        #kinded_mod::ts_union::<Self>(vec![#(#ts_members),*])
      }

      fn decl(cfg: &::ts_rs::Config) -> String {
        format!("type {} = {};", stringify!(#name), <Self as ::ts_rs::TS>::inline(cfg))
      }

      fn decl_concrete(cfg: &::ts_rs::Config) -> String {
        <Self as ::ts_rs::TS>::decl(cfg)
      }

      fn visit_dependencies(v: &mut impl ::ts_rs::TypeVisitor)
      where
        Self: 'static,
      {
        #(v.visit::<#option_types>();)*
      }

      fn output_path() -> Option<::std::path::PathBuf> {
        Some(::std::path::PathBuf::from(concat!(stringify!(#name), ".ts")))
      }
    }

    impl ::serde::Serialize for #name {
      fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
          #(#name::#units => serializer.serialize_str(&#kind::#units.to_string()),)*
          #(#name::#option_variants(options) => {
            #kinded_mod::serialize_kinded_with_options(#kind::#option_variants, options, serializer)
          },)*
        }
      }
    }

    impl<'de> ::serde::Deserialize<'de> for #name {
      fn deserialize<D: ::serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #kinded_mod::deserialize_kinded(deserializer)
      }
    }

    impl #kinded_mod::KindedSet<#name> {
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
  let mut out = String::with_capacity(pascal.len().saturating_add(4));

  for (i, ch) in pascal.char_indices() {
    if ch.is_uppercase() {
      if i != 0 {
        out.push('_');
      }

      out.extend(ch.to_lowercase());
    } else {
      out.push(ch);
    }
  }

  out
}
