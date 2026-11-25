//! Machinery for tagged string-or-object option unions (such as parsers) that
//! accept either a bare name (`"pdf"`) or an object carrying options
//! (`{"type": "pdf", "maxPages": 10}`), collected into a set holding at most
//! one member per kind.

use std::{collections::BTreeMap, fmt::Debug, fmt::Display, marker::PhantomData, str::FromStr};

use serde::{
  Deserialize, Serialize,
  de::{Error as _, MapAccess, SeqAccess, Visitor, value::MapAccessDeserializer},
  ser::{Error as _, SerializeSeq},
};

pub use firecrawl_kinded_macro::kinded;

pub trait Kinded: Sized {
  type Kind: Copy + Ord + Debug + Display + FromStr;

  /// Singular noun for this union, used in error messages.
  const NOUN: &'static str;

  fn kind(&self) -> Self::Kind;

  /// Builds a value of the given kind out of the remainder of its object
  /// (every key except `type`). Kinds without options reject leftover keys.
  fn from_kind_with_options(
    kind: Self::Kind,
    options: serde_json::Map<String, serde_json::Value>,
  ) -> Result<Self, serde_json::Error>;

  /// Members a [`KindedSet`] holds when the caller specifies none.
  fn default_members() -> Vec<Self> {
    Vec::new()
  }
}

fn parse_kind<T: Kinded, E: serde::de::Error>(name: &str) -> Result<T::Kind, E> {
  T::Kind::from_str(name).map_err(|_| E::custom(format!("unknown {}: {}", T::NOUN, name)))
}

struct KindedVisitor<T>(PhantomData<T>);

impl<'de, T: Kinded> Visitor<'de> for KindedVisitor<T> {
  type Value = T;

  fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(
      formatter,
      "a {} name, or an object with a \"type\" key",
      T::NOUN
    )
  }

  fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
    let kind = parse_kind::<T, E>(v)?;
    T::from_kind_with_options(kind, serde_json::Map::new()).map_err(E::custom)
  }

  fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
    let mut object: serde_json::Map<String, serde_json::Value> =
      Deserialize::deserialize(MapAccessDeserializer::new(map))?;

    let kind = object
      .remove("type")
      .ok_or_else(|| A::Error::missing_field("type"))?;
    let kind = kind
      .as_str()
      .ok_or_else(|| A::Error::custom(format!("{} type must be a string", T::NOUN)))?;
    let kind = parse_kind::<T, A::Error>(kind)?;

    T::from_kind_with_options(kind, object).map_err(A::Error::custom)
  }
}

/// [`Deserialize`] implementation delegated to by `#[kinded]` enums.
pub fn deserialize_kinded<'de, T: Kinded, D: serde::Deserializer<'de>>(
  deserializer: D,
) -> Result<T, D::Error> {
  deserializer.deserialize_any(KindedVisitor(PhantomData))
}

/// [`Serialize`] helper for `#[kinded]` variants that carry an options struct.
pub fn serialize_kinded_with_options<K: Display, O: Serialize, S: serde::Serializer>(
  kind: K,
  options: &O,
  serializer: S,
) -> Result<S::Ok, S::Error> {
  let value = serde_json::to_value(options).map_err(S::Error::custom)?;
  let serde_json::Value::Object(mut map) = value else {
    return Err(S::Error::custom(
      "kinded options must serialize to an object",
    ));
  };
  map.insert(
    "type".to_string(),
    serde_json::Value::String(kind.to_string()),
  );
  map.serialize(serializer)
}

/// A set of [`Kinded`] values holding at most one member of any given kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindedSet<T: Kinded>(BTreeMap<T::Kind, T>);

impl<T: Kinded> KindedSet<T> {
  pub fn new() -> Self {
    Self(BTreeMap::new())
  }

  /// Returns the member this displaced, if any.
  pub fn insert(&mut self, value: T) -> Option<T> {
    self.0.insert(value.kind(), value)
  }

  pub fn get(&self, kind: T::Kind) -> Option<&T> {
    self.0.get(&kind)
  }

  pub fn contains(&self, kind: T::Kind) -> bool {
    self.0.contains_key(&kind)
  }

  pub fn len(&self) -> usize {
    self.0.len()
  }

  pub fn is_empty(&self) -> bool {
    self.0.is_empty()
  }

  pub fn iter(&self) -> impl Iterator<Item = &T> {
    self.0.values()
  }
}

impl<T: Kinded> Default for KindedSet<T> {
  fn default() -> Self {
    T::default_members().into_iter().collect()
  }
}

impl<T: Kinded> FromIterator<T> for KindedSet<T> {
  fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
    Self(iter.into_iter().map(|x| (x.kind(), x)).collect())
  }
}

impl<T: Kinded> IntoIterator for KindedSet<T> {
  type Item = T;
  type IntoIter = std::collections::btree_map::IntoValues<T::Kind, T>;

  fn into_iter(self) -> Self::IntoIter {
    self.0.into_values()
  }
}

impl<T: Kinded + Serialize> Serialize for KindedSet<T> {
  fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
    for member in self.0.values() {
      seq.serialize_element(member)?;
    }
    seq.end()
  }
}

struct KindedSetVisitor<T>(PhantomData<T>);

impl<'de, T: Kinded + Deserialize<'de>> Visitor<'de> for KindedSetVisitor<T> {
  type Value = KindedSet<T>;

  fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(formatter, "an array of {}s", T::NOUN)
  }

  fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
    let mut out = KindedSet::new();

    while let Some(value) = seq.next_element::<T>()? {
      let kind = value.kind();
      if out.insert(value).is_some() {
        return Err(A::Error::custom(format!(
          "the {0}s array must not include multiple {0}s of the same type: {1}",
          T::NOUN,
          kind
        )));
      }
    }

    Ok(out)
  }
}

impl<'de, T: Kinded + Deserialize<'de>> Deserialize<'de> for KindedSet<T> {
  fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    deserializer.deserialize_seq(KindedSetVisitor(PhantomData))
  }
}

/// TypeScript union for a [`Kinded`] enum, given each kind and the TS name of
/// its options struct, if it has one. A kind also accepts its bare name when
/// its options deserialize from an empty object.
pub fn ts_union<T: Kinded>(members: Vec<(T::Kind, Option<String>)>) -> String {
  members
    .into_iter()
    .flat_map(|(kind, options)| {
      let bare = T::from_kind_with_options(kind, serde_json::Map::new())
        .is_ok()
        .then(|| format!("\"{kind}\""));
      let object = match options {
        Some(options) => format!("({{ type: \"{kind}\" }} & {options})"),
        None => format!("{{ type: \"{kind}\" }}"),
      };
      bare.into_iter().chain(std::iter::once(object))
    })
    .collect::<Vec<_>>()
    .join(" | ")
}

impl<T: Kinded + ts_rs::TS> ts_rs::TS for KindedSet<T> {
  type WithoutGenerics = Vec<ts_rs::Dummy>;
  type OptionInnerType = Self;

  fn ident(cfg: &ts_rs::Config) -> String {
    <Vec<T> as ts_rs::TS>::ident(cfg)
  }

  fn name(cfg: &ts_rs::Config) -> String {
    <Vec<T> as ts_rs::TS>::name(cfg)
  }

  fn inline(cfg: &ts_rs::Config) -> String {
    <Vec<T> as ts_rs::TS>::inline(cfg)
  }

  fn visit_dependencies(v: &mut impl ts_rs::TypeVisitor)
  where
    Self: 'static,
  {
    <Vec<T> as ts_rs::TS>::visit_dependencies(v);
  }

  fn visit_generics(v: &mut impl ts_rs::TypeVisitor)
  where
    Self: 'static,
  {
    <Vec<T> as ts_rs::TS>::visit_generics(v);
  }
}
