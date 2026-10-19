# DSH UI sources

Theme assets are copied unchanged from deepseek-ai/deepseek-harness commit `687f282e8625c6b8d11ff58211a90524be2e4317`, `packages/client/ui-theme/src/styles`. The React display components use `@deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.2`. Copyright and MIT license are preserved in DSH-LICENSE; the font license is in dsh-theme/Montserrat-OFL.txt.

## Ported host code

The Windows folder picker (`src/server/win32-dialog*.ts`) is ported from the same DSH revision, `packages/host/directory-picker-native/src`: the koffi-backed `IFileOpenDialog` bindings, the COM sequencing, the child-process worker/driver, and their platform-independent sequencing test. The only changes are the worker's title env var (`PI_WEB_DIALOG_TITLE`), the title passed as an argument, and dropping the built-CJS bootstrap arm because pi-web's server always runs from TypeScript. MIT license in DSH-LICENSE.
