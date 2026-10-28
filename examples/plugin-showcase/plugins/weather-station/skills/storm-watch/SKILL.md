---
name: storm-watch
description: Read a forecast result and turn it into a short operational risk note.
---

# Storm Watch

Use this when the user asks about rain, wind, or travel risk.

1. Call the plugin's `forecast` tool with the city.
2. Summarize rain probability, wind, and visibility in one short paragraph.
3. If rain probability is above 60%, add one concrete precaution.
4. Keep the answer under five lines unless the user asks for detail.
