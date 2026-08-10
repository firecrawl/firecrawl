//! Machinery for formats and parsers. Both are enums whose variants may carry
//! options, which the API accepts either as a bare name (`"markdown"`) or as an
//! object carrying those options (`{"type": "screenshot", "fullPage": true}`),
//! and which are collected into a set holding at most one member per kind.

use std::{collections::BTreeMap, fmt::Debug, fmt::Display, marker::PhantomData, str::FromStr};

use serde::{
  Deserialize,
  de::{Error as _, MapAccess, SeqAccess, Visitor, value::MapAccessDeserializer},
};

pub trait Kinded: Sized {
  type Kind: Copy + Ord + Debug + Display + FromStr;

  /// Singular noun for this union, used in error messages.
  const NOUN: &'static str;

  fn kind(&self) -> Self::Kind;

  /// Builds a value of the given kind out of the remainder of its object --
  /// i.e. every key except `type`. Kinds that take no options are expected to
  /// reject leftover keys.
  fn from_kind_with_options(
    kind: Self::Kind,
    options: serde_json::Map<String, serde_json::Value>,
  ) -> Result<Self, serde_json::Error>;

  /// Members a [`KindedSet`] holds when the user specifies none.
  fn default_members() -> Vec<Self> {
    Vec::with_capacity(0)
  }
}

fn parse_kind<T: Kinded, E: serde::de::Error>(name: &str) -> Result<T::Kind, E> {
  T::Kind::from_str(name).map_err(|_| E::custom(format!("unknown {}: {}", T::NOUN, name)))
}

struct KindedVisitor<T>(PhantomData<T>);

impl<'de, T: Kinded> Visitor<'de> for KindedVisitor<T> {
  type Value = T;

  fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
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

/// [`Deserialize`] implementation for a [`Kinded`] enum. The enums can't get
/// this via a blanket impl, so each one delegates to this from its own impl.
pub fn deserialize_kinded<'de, T: Kinded, D: serde::Deserializer<'de>>(
  deserializer: D,
) -> Result<T, D::Error> {
  deserializer.deserialize_any(KindedVisitor(PhantomData))
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

struct KindedSetVisitor<T>(PhantomData<T>);

impl<'de, T: Kinded + Deserialize<'de>> Visitor<'de> for KindedSetVisitor<T> {
  type Value = KindedSet<T>;

  fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
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

/// Derives everything a [`Kinded`] enum needs -- its discriminant enum, the
/// [`Kinded`] and [`Deserialize`] impls, and the typed option accessors on its
/// [`KindedSet`]. Unit variants are kinds without options; single-field tuple
/// variants are kinds with options, reachable as `.snake_case_name()`.
pub(crate) use kinded_macro::kinded;
