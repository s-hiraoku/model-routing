# model-feedback

Use this skill when the user gives freeform feedback about model routing behavior, such as a task category being too aggressively demoted or promoted.

## Action

Record the user's feedback exactly as a feedback note:

```bash
bun run feedback -- add "<feedback text>" --source model-feedback
```

Do not interpret or rewrite the request before storing it. Policy interpretation happens later in the M5 feedback stage.

After recording, briefly report the stored feedback ID from the command output.
