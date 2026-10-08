# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the label strings this repo's issue tracker actually uses.

| Label in mattpocock/skills | Label in our tracker   | Meaning                                  |
| -------------------------- | ---------------------- | ---------------------------------------- |
| `needs-triage`             | `status: needs-triage` | Maintainer needs to evaluate this issue  |
| `needs-info`               | none yet               | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`      | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`      | Requires human implementation            |
| `wontfix`                  | `wontfix`              | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table. There is no `needs-info` label yet: say in a comment what information is missing, and leave the issue in `status: needs-triage`. The bare `needs-triage` label is a duplicate of `status: needs-triage`; apply the `status:` one.
