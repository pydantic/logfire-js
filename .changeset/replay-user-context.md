---
'@pydantic/logfire-session-replay': patch
'@pydantic/logfire-browser': minor
---

Include the reported user in session replay chunk metadata. Browser spans already carried `user.id`, `user.name`, and `user.email` from `rum.session.getUser()`, but replay chunks carried only `distinctId`, so a replay service could not show who a recording belongs to or find it by email. Each chunk now snapshots the user once into an optional `meta.user` with only `id`, `name`, and `email`, and derives `distinctId` from that same snapshot unless `sessionReplay.getDistinctId` overrides it. Standalone replay users can pass the new `getUser` option.
