# Voice samples

Drop 3-5 samples of your own writing in this folder. They get loaded into the cover-letter
generation prompt as exemplars the model calibrates its _voice_ against — sentence rhythm, word
choice, how thoughts connect — not as content or structure to copy.

## Format

- One writing sample per file, plain text or markdown (`.txt` or `.md`).
- Doesn't need to be cover letters — any authentic personal writing works: emails, blog posts,
  Slack messages, old cover letters, whatever sounds like you. The more varied and unedited, the
  better the signal.
- Keep each file reasonably short (a couple hundred words) — content is embedded directly into
  the prompt, so there's a practical budget.
- No metadata or frontmatter needed. The entire file content is used verbatim.
- `README.md` itself is always excluded from loading.

## Privacy

Files you add here (other than this README) are gitignored — they won't be committed or pushed.
If the folder has no samples yet, generation just skips the voice-exemplar section rather than
falling back to a canned example.
