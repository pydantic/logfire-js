# Default export addition

I need to add a default export to all packages in this monorepo. The default export object should be the same as the star import. For example, the following two codes are equivalent:

```ts
import * as logfire from 'logfire';
```

```ts
import logfire from 'logfire';
```

Implement this for every package in the monorepo. Do not touch the examples.

## Details

Explicitly construct the default export object using the current imports. This should happen in the index.ts files.

## Testing

Test this feature by rebuilding the packages and verifying the resulting bundles.
