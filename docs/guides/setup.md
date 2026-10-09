# Setting up StoreOps

From nothing to a working web app in about 30 minutes. For how releases work
after that, see [deployment](../architecture/deployment.md).

## You need

- A Google account that will own the Sheet and the script
- Node.js (LTS) and Git
- `clasp`: `npm install -g @google/clasp`

## 1. Get the code

```sh
git clone <repo-url> StoreOps
cd StoreOps
npm install
npm test          # every suite should be green before you deploy anything
```

## 2. Create the Sheet and the script

1. Create a blank Google Sheet and name it **StoreOps**.
2. **Extensions → Apps Script** opens a script project bound to the Sheet.
   Name it **StoreOps** too.
3. Copy the **Script ID** from the editor URL:
   `script.google.com/d/<SCRIPT_ID>/edit`.

## 3. Push the code

```sh
clasp login
echo '{"scriptId":"<SCRIPT_ID>","rootDir":"src"}' > .clasp.json
clasp push
```

`rootDir: src` means only `src/` is uploaded; docs and tests stay local.

## 4. Build the schema

1. Reload the Sheet. A **🏪 StoreOps** menu appears.
2. Run **⚙️ First-time Setup** and authorise it. The "unverified app" warning
   is normal for a script you deployed yourself.
3. Setup creates every tab with its header and a placeholder row, and fills
   `config` with defaults. Then run each **Add …** migration in the menu once.
   They are safe to run twice, and running them all brings a new sheet to
   the current shape. Skip **Migrate Product Master → v2**: it converts a
   pre-2026-08 product table and archives the old one, which a new sheet
   doesn't have.

The full list of tabs and columns is in the
[schema reference](../reference/schema.md).

## 5. Add people

In the `staff` tab, replace the placeholder admin row with yourself:
`staff_id` `S_001`, your name, `active` TRUE, `role` `admin`, a 4-digit
`login_code`, `companies_authorized` `cstore,vape`. Add the others the same way
(roles: `admin`, `manager`, `payroll_admin`, `employee`). Delete the
placeholder rows in the other tabs.

## 6. Configure

In `config`, at minimum:

| Key | Set to |
|---|---|
| `cash_manager_staff_id` | the `staff_id` of whoever holds the business cash |
| `cstore_card_split`, `vape_card_split` | `false` for a till that reports one card total |
| `notifier_enabled`, `whatsapp_*` | when you're ready to send messages ([templates](whatsapp-templates.md)) |
| `clover_enabled`, `clover_<till>_*` | for tills on Clover |

## 7. Deploy the web app

In the Apps Script editor: **Deploy → New deployment → Web app**.
**Execute as: Me**, **Who has access: Anyone**. These match
`src/appsscript.json`; "Anyone" is what lets the public report links work, and
the app itself is behind the PIN login. Copy the `/exec` URL into
`public_report_url`.

## 8. Try it

Open the URL on a phone and sign in with your name and PIN. Open a till, close
it, and check that the Reconcile tab shows the shift.

## 9. Hand deploys over to GitHub Actions

Put your `~/.clasprc.json` in the repo secret `CLASPRC_JSON`, set the script ID
in `.github/workflows/deploy.yml`, and optionally set the `PROD_DEPLOYMENT_ID`
repo variable so each merge also publishes a new version. From then on, merging
to `main` deploys.

## Troubleshooting

See [deployment → troubleshooting](../architecture/deployment.md#troubleshooting).
