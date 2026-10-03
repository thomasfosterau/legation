---
"@thomasfosterau/legation-effect": minor
---

The Node/Edge resource model lands (ADR-0022, program step 2): `Node.make`
defines a typed resource — attributes plus edges (`Edge.one` with its
foreign-key `via`, `Edge.many`/`Edge.paginated` naming their `inverse`,
order as part of a paginated edge's identity) — with per-type branded ids
(one-edge fields carry the target's brand) and declared `hintKeys`.
`Node.registry` closes and validates the graph (targets exist, inverses
resolve to a matching one-edge) and derives the engine's
`CollectionRegistry`, so existing engines, `Related` joins, and auth
filters consume Node definitions today; `Node.derivableSet` exposes the
ADR-0023 fan-out fields. Additive — nothing existing changes.
