---
'@pydantic/logfire-session-replay': minor
'@pydantic/logfire-browser': minor
---

Let one document at a time write a session replay recording. A duplicated tab could continue another tab's recording and upload different events under the same sequence numbers, which the Platform rejects, so the recording lost events. A document now uploads under a recording only while it holds that recording's Web Lock, and continues from the sequence that a record shared through `localStorage` confirms. A copy whose recording another tab holds starts a new recording after up to one second. Recording still starts at once. Until a continued recording's lock is granted, `getRecordingId()` returns an empty string and spans have no recording link. The lock is released at `pagehide`, so pages stay eligible for the back-forward cache. Browsers without Web Locks or writable `localStorage` keep the previous behavior.
