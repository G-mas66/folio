# Folio Word

Folio provides a Windows desktop Word COM add-in for searching the library and inserting APA 7 or GB/T 7714-2015 numeric citations. The add-in is installed per Windows user from Folio Settings; it does not use the Office Store, a shared folder, a certificate script, or Word's Trusted Locations.

## Install and remove

1. In Folio, open **Settings → Browser and Word plugins** and choose **Install Word plugin**. The installer copies the native add-in to `%LOCALAPPDATA%\Folio\Word\native` and registers it for the current user in the 32-bit and 64-bit Word registry views.
2. Close and reopen Word if it was already running. The **Folio** ribbon tab appears when Word loads the add-in.
3. Use **Repair** from the same Settings page after closing Word. To uninstall, choose **Uninstall** there. If Word is open, close it and choose **Uninstall** again to remove the remaining local files.

Install and uninstall change only Folio's per-user files and registry entries. They do not change macro policy, Trust Center settings, certificate stores, or Word documents. The add-in is unsigned; an organization policy that requires signed COM add-ins may block activation. A successful install status confirms registration, not that Word activated the add-in.

## Use citations

In Word, choose **Folio → Search and insert citation**. Select a folder and citation style, search the Folio library, and preview the citation before confirming. The style defaults to the current document's saved Folio style. New citations require a current confirmation for the selected style; the add-in checks the record again after the preview and stops if its metadata changed.

The preview uses the citation engine's body citation and complete bibliography output. Missing optional metadata is shown as a warning for review. The citation is inserted at the current Word selection. **Refresh document citations** follows the order of Word's Folio content controls, updates snapshots only from records currently confirmed in the selected style, preserves manual text edits, and keeps an existing snapshot when a record is stale or unavailable.

CSL snapshots and managed citation controls are stored in the document. Existing document text remains available when Folio is closed, but inserting, refreshing, or changing the rendered style requires Folio to be running. Save the Word document after inserting or refreshing.

The native add-in cannot automatically migrate citation state stored by the older Office.js task pane. If a document has Folio-tagged controls but no native snapshot, the add-in stops before changing it and explains the limitation. Keep the original document; to use the native add-in, work on a copy and convert the old Folio controls to ordinary text before starting a new native citation set.

## Compatibility and development

The native add-in targets Windows desktop Word and builds separate 32-bit and 64-bit .NET Framework assemblies. This workspace has not verified activation or insertion/save/reopen in a live Word host. The local reflection and pipe tests validate the built DLL and protocol, not Word's COM activation or document editing behavior.

Build the native assemblies with `extensions/word/native/build.ps1`. Run `extensions/word/tests/native-smoke.ps1` for the DLL interface, named-pipe RPC, and bibliography-sanitizer smoke checks. Run `npm --prefix extensions/word test` for the Word extension tests.

## Legacy Office.js development workflow

These steps apply only to the older Office.js task pane for development or compatibility testing. They are not required by the native Settings installer and still require manual setup:

1. This token step applies only to an older development build that still exposes the Office.js pairing-credential UI. The current native plugin Settings page does not provide that legacy token entry point.
2. From PowerShell, run `extensions/word/scripts/Install-WordDevCertificate.ps1`. The script creates a localhost HTTPS certificate. Typing `TRUST` at its prompt imports that certificate into the current user's Root store; skipping the prompt leaves it untrusted.
3. Place `extensions/word/manifest.xml` in a Windows file share and add its UNC path under Word's **Trust Center → Trusted Add-in Catalogs**. Restart Word.
4. In Word, add the manifest from **Insert → My Add-ins → Shared Folder**, open the Folio task pane, and paste the copied token.

The Office.js task pane uses the legacy localhost HTTPS service and token flow. Its certificate and catalog setup are explicit developer steps; the Folio Settings installer does not run them.

Third-party dependencies and CSL style licenses are listed in [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md).
