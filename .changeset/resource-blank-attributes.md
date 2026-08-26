---
'@pydantic/logfire-node': patch
---

Leave a blank first-class resource option off the resource instead of recording an empty value. `LOGFIRE_ENVIRONMENT=` reached the resource as `deployment.environment.name: ""` on every span, where the Python SDK omits the attribute.
