---
'logfire': patch
---

Stop reporting item fields inside an `each` or `with` block as missing template inputs. `variablesValidate` collected bare paths from a block body and checked them against the root `templateInputsSchema`, so `{{#each items}}{{name}}{{/each}}` was flagged for `name` even though the template renders correctly.
