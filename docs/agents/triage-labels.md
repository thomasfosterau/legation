# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker: the programme-wide `status:` vocabulary the sibling repositories use, so one triage query works across them.

| Label in mattpocock/skills | Label in our tracker   | Meaning                                  |
| -------------------------- | ---------------------- | ---------------------------------------- |
| `needs-triage`             | `status: needs-triage` | Maintainer needs to evaluate this issue  |
| `needs-info`               | `status: needs-info`   | Waiting on reporter for more information |
| `ready-for-agent`          | `status: agent-ready`  | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `status: human-ready`  | Requires human implementation            |
| `wontfix`                  | `status: wontfix`      | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.
