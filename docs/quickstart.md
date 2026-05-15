# Quickstart — getting StoreOps deployed

About 30 minutes from zero to working web app.

## Prerequisites

- Node.js (LTS recommended)
- Git
- A Google account
- `clasp` installed: `npm install -g @google/clasp` (or use `npx clasp`)

Verify:

```cmd
node --version
git --version
```

## 1. Extract the bundle

If you received a zip, extract to:

```
C:\Users\ashin\Desktop\StoreProjects\StoreOps\
```

If pulling from git:

```cmd
cd C:\Users\ashin\Desktop\StoreProjects
git clone <repo-url> StoreOps
cd StoreOps
```

## 2. Initialize repo (if not from git)

```cmd
cd C:\Users\ashin\Desktop\StoreProjects\StoreOps
git init
git add -A
git commit -m "Initial StoreOps scaffolding"
```

## 3. Install dev tooling

```cmd
npm install
```

## 4. Log into clasp

```cmd
npx clasp login
```

Browser opens — sign in with the Google account that will own the
Apps Script project.

## 5. Create the Google Sheet

1. Open https://sheets.google.com → Blank
2. Rename it: **StoreOps**
3. Extensions → Apps Script (opens new tab, project bound to sheet)
4. Rename the Apps Script project: **StoreOps**
5. Copy the Script ID from the URL:
   `script.google.com/d/{SCRIPT_ID}/edit`

## 6. Link clasp

```cmd
copy .clasp.json.example .clasp.json
notepad .clasp.json
```

Paste the Script ID, save.

## 7. Push the code

```cmd
npx clasp push
```

Confirm `y` if asked. Should see all `.gs` + `.html` files uploaded.

## 8. Run first-time setup

1. Go back to the **Google Sheet** tab
2. Reload it — menu appears
3. **🏪 StoreOps → ⚙️ First-time Setup**
4. Authorize when prompted (you'll see "unverified" warnings — that's
   normal for self-deployed apps, click through)
5. Setup creates all 14 sheets with proper columns + 1 placeholder row
   in each operational table

## 9. Replace placeholder rows with real data

1. Go to the `staff` sheet
2. Replace the placeholder admin row with your actual info:
   - StaffID: `S_001`
   - Name: your name
   - HourlyRate: whatever makes sense (admin row often `0`)
   - Active: `TRUE`
   - Role: `admin`
   - LoginCode: pick a 4-digit code
   - CompaniesAuthorized: `cstore,vape`
3. Add other staff rows manually (S_002, S_003, etc.) — or use the
   admin UI later once Batch 4 is built
4. Review placeholder rows in `attendance`, `till_sessions`, etc. — delete
   them when you're satisfied the schema looks right

## 10. Deploy as web app

In Apps Script editor:
1. **Deploy → New deployment** → gear → Web app
2. Description: `v1.0 initial`
3. Execute as: Me
4. Who has access: Anyone with a Google account
5. Click Deploy → copy URL → **copy Deployment ID too**

## 11. Test on your phone

1. Open the URL on your phone
2. Sign in with your admin name + code
3. Verify you can see all tabs (Schedule, Payroll, Sales, History)

## Daily workflow from now on

```cmd
cd C:\Users\ashin\Desktop\StoreProjects\StoreOps
# edit in your IDE
git add -A
git commit -m "Describe change"
npx clasp push
# test on the test deployment URL

# when ready to push to production:
npx clasp deploy --description "v1.X.Y description" --deploymentId <prod-id>
git tag v1.X.Y
git push --tags
```

## Troubleshooting

See [`troubleshooting.md`](troubleshooting.md) (built out as issues come up).

Common ones:
- **Menu doesn't appear** → reload the sheet
- **Login screen empty dropdown** → no `active=TRUE` staff in `staff` sheet
- **"NOT_LOGGED_IN" loop** → clear `sessionStorage` in browser devtools,
  or click logout
- **Authorization required errors** → run any function once from Apps
  Script editor to trigger OAuth prompt
