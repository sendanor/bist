# OpenAI integration

## Current API access

In the OpenAI project's API key settings, choose **Restricted** and grant these permissions.

| Permission                | Endpoint             | Use in Bist                                                                                  |
| ------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| **List models · Read**    | `GET /v1/models`     | Populate the model picker and check whether the selected model appears in the key's catalog. |
| **Responses API · Write** | `POST /v1/responses` | Answer questions about published recipes using Bist's read-only lookup functions.            |

Set unused key permissions to **None**. If your organization uses custom project roles,
check that the key's identity can make model requests through **Model capabilities ·
Request**. This is a project role permission. A model's presence in the list confirms
catalog access. Ask a question in Bist to verify inference and function calling.
[OpenAI permission reference](https://developers.openai.com/api/docs/guides/rbac)

The Worker holds the API key and calls OpenAI. It sends the question and selected published
recipe data as needed. It sets `store: false` on Responses requests. OpenAI's API data
controls explain which retention policies still apply.
[OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)

## Candidate features

| Priority        | API                                                                                              | Use in Bist                                                                                                                                        | What to measure                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| First pilot     | [Decisions](https://developers.openai.com/api/docs/guides/decisions)                             | Suggest tags from the instance's existing vocabulary and flag submissions that might need a closer look. Show suggestions to the reviewer.         | Tag acceptance rate, false positives, and review time on a maintainer-labeled sample.                                |
| Second pilot    | [Embeddings](https://developers.openai.com/api/docs/guides/embeddings)                           | Augment keyword and tag search with semantic ranking of published recipes. Offer related recipes and potential near-duplicates as suggestions.     | Compare the first five results with keyword search on representative queries. Track query latency and indexing cost. |
| As needed       | [Responses Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) | Draft a review note, a test plan, or a Markdown summary in a schema the UI can validate and present for editing.                                   | Schema validity, factual accuracy, and how often maintainers keep the suggestions.                                   |
| As volume grows | [Batch](https://developers.openai.com/api/docs/guides/batch)                                     | Backfill embeddings for a large library or run offline Responses evaluations. The documented supported endpoints include Embeddings and Responses. | Cost per backfill, completion time, and recovery after interrupted jobs.                                             |

For shorter perceived wait times, the existing Responses endpoint supports streaming.
The Worker would still own tool calls and stream only user-facing text to the browser.
[Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses)

Hosted File Search can manage retrieval over uploaded files. Evaluate it if Bist needs
to search a separate document collection. A Bist-owned recipe index makes revision
visibility and withdrawal easier to enforce alongside the existing library.
[OpenAI File Search](https://developers.openai.com/api/docs/guides/tools-file-search)

## Architecture for the pilots

- Keep authorization, exact duplicate detection, quality checks, and publication in
  Bist. A model's output can suggest a change. A maintainer applies it through the normal
  review workflow.
- Start with published titles, summaries, and tags. Treat sending unpublished content
  as a separate administrator-enabled feature. Send selected excerpts only after checking
  the requesting maintainer's access. Treat submitted text as data.
- Treat the semantic index as derived data. Key entries by revision ID and embedding
  model. Refresh entries after publication, remove withdrawn entries, and verify each
  candidate's publication status before displaying it. Keep keyword and tag search
  available if the provider or index is unavailable.
- Make each provider feature independently configurable. Grant extra API permissions
  when the corresponding feature is enabled. Keep offline job credentials separate from
  the interactive assistant key if those jobs require broader permissions.
- Keep representative evaluation fixtures and expected outcomes in the project. Run
  regression evaluations outside the request path. OpenAI marks its hosted Evals
  dashboard, API, and eval-workflow graders as read-only starting November 30, 2026.
  [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)
