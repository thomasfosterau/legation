# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Epics are exempt from state roles

An **epic** — an issue whose work is tracked by its children rather than done directly — carries no state role. Its state is the rollup of its children, and a state label on the epic would only duplicate that while going stale independently.

So an epic carries its category and topic labels (`design`, `phase-*`, and so on) but never `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` or `wontfix`. A triage run should skip epics when listing untriaged work, and close one when its children are all done.

This is an exemption from the general rule that every triaged issue carries exactly one category role and one state role. It applies only to epics; a design issue that is _not_ an epic (no children, the work is the design) is triaged normally and usually lands in `ready-for-human`.
