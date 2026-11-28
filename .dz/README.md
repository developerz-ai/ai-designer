# `.dz/`

The developerz.ai maintainer bot's configuration for this repo. The platform owns the layout.

| Path | What |
|---|---|
| `maintainer/maintainer.yml` | the policy: what the bot triages, closes, reviews, merges and releases. [Reference](https://developerz.ai/docs/maintainer-yml) |
| `pipeline/agent-pipeline.json` | the agent pipeline definition (merge `reviewGate`) |
| `schedules/` | what each `schedules:` checkup works from, read at `main`'s HEAD when it fires: `improve.md` (first and third Monday of the month, `weeks_of_month: [1, 3]`: at most three small, evidenced improvements). There is no `release-due` here yet: see `release:` in the policy |
