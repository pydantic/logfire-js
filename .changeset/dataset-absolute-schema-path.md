---
'logfire': patch
---

Record an absolute `schemaPath` relative to the dataset file in `Dataset.toFile`. The absolute path was written verbatim into `$schema` and into the `yaml-language-server` comment, so a dataset committed from one machine pointed at a directory that exists nowhere else and the schema silently stopped resolving. A path outside the dataset's own directory is still written as given.
