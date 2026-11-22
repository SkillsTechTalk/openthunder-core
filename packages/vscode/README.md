# OpenThunder: Definition of Done

See whether your change meets your team's Definition of Done, and the evidence behind each answer, without leaving VS Code.

- **One answer per change:** Done, Done with exceptions, or Not done, with what still keeps it from Done first.
- **Evidence, not opinions:** your JUnit test reports, lcov coverage, SARIF scanner results, and an OpenAPI compatibility check, each tied to the code it describes. A report older than your code is **Outdated**; a missing one is **Not checked**, never a pass.
- **Changed lines only:** uncovered changed lines are marked in the editor; scanner findings show only on the files you changed.
- **Accepted risk stays visible:** an exception names its approver and expiry, and the original result is still shown.
- **Your policy, your rules:** `.openthunder/done.yml` is read from the branch you merge into, so a change cannot loosen the rules that judge it.
- **More checks with the free OpenThunder app (optional):** if your policy asks for `check: openthunder.<item>` (impacted tests, weakened tests, broken callers, and more), run *OpenThunder: Run OpenThunder's Checks*. It runs the installed app, which writes its results as receipts this extension counts like any other. This extension contains none of the app's code.
- **Works with GitHub Copilot:** in agent mode, Copilot can call the *Definition of Done* tool before it says a change is finished. Reference it in chat as `#definitionOfDone`.

Local only: it reads files and git history, never runs project code, makes no network call, and needs no account or AI key. It works in Restricted Mode.

Start with **OpenThunder: Create Definition of Done**, adjust it, and commit it to your base branch.
