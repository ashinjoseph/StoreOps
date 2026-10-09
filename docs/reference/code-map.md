# Code map

> **Generated** by `npm run docs:codemap` from `src/`. Do not edit by hand.
> The docs-guard suite fails when this file is stale.

Where everything is, for people and for coding agents. Purpose lines come from
each file's header comment, the API from the module object the code actually
builds, and RPC roles from the `Auth.require` call in each endpoint. For *why*
things are the way they are, see the [ADRs](../adr/README.md); for what each
feature does, the [component pages](../components/README.md).

## Contents

- [Server modules](#server-modules)
- [RPC endpoints](#rpc-endpoints)
- [Pages](#pages)
- [Vocabulary](#vocabulary)

## Server modules

Each `.gs` file defines one module object (an IIFE) with the same name as the
file, except `WebApp.gs` and `Setup.gs`, which define top-level functions.
Apps Script loads every file into one global scope.

| Module | Lines | Purpose | Tabs (`SHEETS.*`) | Calls | Loaded by suites |
|---|---:|---|---|---|---|
| [`Attendance`](#attendance) | 550 | per-day workday records (payroll source of truth) | `attendance` | Payments, Staff, TillSessions | **none** |
| [`AuditLog`](#auditlog) | 93 | append-only event log | `audit_log` | — | import-perf |
| [`Auth`](#auth) | 237 | login, session tokens, role guards | `config` | Staff | **none** |
| [`Bonuses`](#bonuses) | 382 | bonuses, commissions, adjustments | `bonuses` | Payments, Staff | commission-fixed |
| [`CashHandling`](#cashhandling) | 554 | cash in a cashier's hands, until it isn't | `cash_handover_items`, `cash_handovers`, `config` | Staff, TillSessions | cash-handling |
| [`Clover`](#clover) | 128 | Clover REST API client (card totals for a day) | `config` | — | **none** |
| [`CommissionRules`](#commissionrules) | 316 | CRUD for commission_rules tab | `commission_rules` | Staff | commission-fixed |
| [`Commissions`](#commissions) | 398 | weekly commission engine + Monday trigger | `commission_runs`, `config` | Bonuses, CommissionRules, Notifier, Sales, Staff | commission-fixed |
| [`Notifier`](#notifier) | 265 | WhatsApp Cloud API sends + internal event log | `config` | — | notifier |
| [`OrderCatalog`](#ordercatalog) | 148 | master list of orderable items | `order_catalog` | — | **none** |
| [`Payments`](#payments) | 616 | payment recording, two distinct flows | `payment_items`, `payments` | Attendance, Bonuses, Notifier, Staff | **none** |
| [`ProductMaster`](#productmaster) | 1087 | thin CORE catalog of products | `_pm_beer_staging`, `_pm_cig_staging`, `_pm_other_staging`, `_pm_vape_staging`, `product_master` | ProductTypes, Setup | import-perf, shopping-gate |
| [`ProductTypes`](#producttypes) | 239 | per-product-type registry | — | ProductMaster, Setup | import-perf, shopping-gate |
| [`PublicReport`](#publicreport) | 244 | the 7-day report served outside the app | — | CashHandling, Reconcile, Sales, TillSessions | public-report, reconcile |
| [`Reconcile`](#reconcile) | 758 | per-shift cashier vs Clover reconciliation | `config`, `validation_results` | CashHandling, Clover, Notifier, Sales, Staff, TillSessions | link, reconcile |
| [`Sales`](#sales) | 694 | sales rows (one per till_session) | `config`, `sales` | Setup, Staff, TillSessions | parity, perf, sales-cards, sales-insights |
| [`Setup`](#setup) | 1582 | first-time schema creation + menu + placeholders | `_pm_beer_staging`, `_pm_cig_staging`, `_pm_import_staging`, `_pm_other_staging`, `_pm_vape_staging`, `attendance`, `audit_log`, `bonuses`, `cash_handover_items`, `cash_handovers`, `clover_batches`, `commission_rules`, `commission_runs`, `config`, `order_catalog`, `payment_items`, `payments`, `pos_extracted`, `product_beer_detail`, `product_cigarettes_detail`, `product_master`, `product_vape_detail`, `sales`, `shopping_list`, `staff`, `suppliers`, `till_sessions`, `validation_results` | CashHandling, Commissions, ProductMaster, ProductTypes | **none** |
| [`ShoppingList`](#shoppinglist) | 368 | shared "to order" list + generation | `shopping_list` | Notifier, ProductMaster, Staff | shopping-gate |
| [`Staff`](#staff) | 172 | staff roster operations | `staff` | — | **none** |
| [`Suppliers`](#suppliers) | 65 | supplier reference (read-only in app) | `suppliers` | — | **none** |
| [`TillSessions`](#tillsessions) | 793 | per-company cash reconciliation | `config`, `till_sessions` | Attendance, Notifier, Sales, Staff | cash-handling, link, lotto-payout, reconcile |
| [`Util`](#util) | 190 | date/ID/money/parsing helpers (no sheet access) | — | — | cash-handling, commission-fixed, import-perf, link, lotto-payout, notifier, parity, perf, public-inline, public-report, reconcile, routing, rpc-guards, sales-cards, sales-insights, shopping-gate, wiring |
| [`WebApp`](#webapp) | 1506 | HTTP entry point + RPC layer | `commission_rules` | Attendance, Auth, Bonuses, CashHandling, CommissionRules, Commissions, Notifier, OrderCatalog, Payments, ProductMaster, ProductTypes, PublicReport, Reconcile, Sales, ShoppingList, Staff, Suppliers, TillSessions | public-inline, routing, rpc-guards, template-guard, wiring |

## RPC endpoints

Called from the browser as `google.script.run.<name>(...)` (wrapped by `call` /
`cachedCall` in `Index.html`). Every endpoint takes the session token first and
reads identity and role from the server session, never from its arguments.
Roles: `admin`, `manager`, `payroll_admin`, `employee`.

| RPC | Parameters | Allowed | Calls |
|---|---|---|---|
| `rpcGetActiveStaffForLogin` | `` | **no session check** | Staff |
| `rpcLogin` | `name, code` | **no session check** | — |
| `rpcLogout` | `token` | **no session check** | — |
| `rpcGetMe` | `token` | any signed-in | — |
| `rpcGetBootstrap` | `token` | any signed-in | Attendance, CashHandling, Sales, TillSessions |
| `rpcGetStaffDirectory` | `token` | any signed-in | Staff |
| `rpcGetMyOwedSummary` | `token` | any signed-in | Payments, Staff |
| `rpcGetMyShiftState` | `token` | any signed-in | Attendance, CashHandling, Sales, TillSessions |
| `rpcOpenShift` | `token, input` | any signed-in | TillSessions |
| `rpcNotifyShiftOpen` | `token, company` | any signed-in | Notifier |
| `rpcCloseShift` | `token, input` | any signed-in | TillSessions |
| `rpcGetWeekSchedule` | `token, weekStartStr` | any signed-in | Attendance, Staff |
| `rpcScheduleShift` | `token, input` | admin, manager | Attendance |
| `rpcCancelScheduledShift` | `token, attendanceId, reason` | admin, manager | Attendance |
| `rpcAdjustAttendanceHours` | `token, attendanceId, basis` | admin, manager | Attendance |
| `rpcEditAttendanceTimes` | `token, input` | admin | Attendance |
| `rpcGetPayrollOverview` | `token` | admin, payroll_admin | Payments, Staff |
| `rpcGetOwedSummary` | `token, staffId` | admin, payroll_admin | Payments |
| `rpcPayShifts` | `token, input` | admin, payroll_admin | Payments |
| `rpcPayBonus` | `token, input` | admin, payroll_admin | Payments |
| `rpcUndoPayment` | `token, paymentId` | admin, payroll_admin | Payments |
| `rpcGetProposedBonuses` | `token` | admin, payroll_admin | Bonuses, Staff |
| `rpcApproveBonus` | `token, bonusId` | admin, payroll_admin | Bonuses |
| `rpcCancelBonus` | `token, bonusId, reason` | admin, payroll_admin | Bonuses |
| `rpcCreateBonus` | `token, input` | admin | Bonuses |
| `rpcGetSalesDashboard` | `token, filters` | admin, manager, payroll_admin | Sales |
| `rpcReconcileDay` | `token, force` | any signed-in | Reconcile |
| `rpcGetReconciliation` | `token, limit` | admin, manager, payroll_admin | Reconcile |
| `rpcGetCashPosition` | `token` | any signed-in | CashHandling |
| `rpcRecordCashHandover` | `token, input` | any signed-in | CashHandling |
| `rpcVoidCashHandover` | `token, handoverId` | any signed-in | CashHandling |
| `rpcGetCashOutstandingFor` | `token, staffId` | any signed-in | CashHandling |
| `rpcGetCashHandoverHistory` | `token, limit, staffId` | any signed-in | CashHandling |
| `rpcGetPaymentHistory` | `token, limit` | any signed-in | Payments, Staff |
| `rpcGetCommissionRuns` | `token, limit` | admin, manager, payroll_admin | Commissions, Staff |
| `rpcRunCommissionEngine` | `token, force` | admin, payroll_admin | Commissions |
| `rpcGetCommissionRules` | `token` | admin, manager, payroll_admin | CommissionRules |
| `rpcCreateCommissionRule` | `token, input` | admin, payroll_admin | CommissionRules |
| `rpcUpdateCommissionRule` | `token, input` | admin, payroll_admin | CommissionRules |
| `rpcGetAllStaff` | `token` | admin | Staff |
| `rpcGetSuppliers` | `token` | any signed-in | Suppliers |
| `rpcGetOrderCatalog` | `token` | any signed-in | OrderCatalog |
| `rpcAddCatalogItem` | `token, input` | any signed-in | OrderCatalog |
| `rpcGetShoppingList` | `token` | any signed-in | ShoppingList, Staff |
| `rpcSetShoppingItemBought` | `token, entryId, bought` | any signed-in | ShoppingList |
| `rpcClearShoppingList` | `token` | manager, admin, payroll_admin | ShoppingList |
| `rpcAddToShoppingList` | `token, input` | any signed-in | ShoppingList |
| `rpcRemoveShoppingListEntry` | `token, entryId` | any signed-in | ShoppingList |
| `rpcEditShoppingListEntry` | `token, entryId, patch` | any signed-in | ShoppingList |
| `rpcGenerateShoppingList` | `token` | manager, admin, payroll_admin | ShoppingList |
| `rpcGetProductMaster` | `token, filter` | any signed-in | ProductMaster |
| `rpcGetProductsForPicker` | `token` | any signed-in | ProductMaster |
| `rpcSearchProducts` | `token, query, opts` | any signed-in | ProductMaster |
| `rpcGetProduct` | `token, productId` | any signed-in | ProductMaster |
| `rpcGetProductCategories` | `token` | any signed-in | ProductMaster |
| `rpcGetProductTypeSchema` | `token, category` | any signed-in | ProductTypes |
| `rpcCreateProduct` | `token, input` | any signed-in | ProductMaster |
| `rpcUpdateProduct` | `token, productId, patch` | any signed-in | ProductMaster |
| `rpcDeactivateProduct` | `token, productId` | admin, manager | ProductMaster |
| `rpcReactivateProduct` | `token, productId` | admin, manager | ProductMaster |
| `rpcImportProductMasterFromStaging` | `token, opts` | admin | ProductMaster |

61 endpoints.

## Pages

| File | Lines | Served by | Client functions |
|---|---:|---|---:|
| `src/Index.html` | 6118 | `doGet` (no `?v`) | 134 |
| `src/Public.html` | 340 | `doGet` `?v=recon` | 9 |
| `src/PublicSales.html` | 357 | `doGet` `?v=sales` | 9 |

## Vocabulary

Constants defined in `Setup.gs` and used across modules. A status written to a
sheet must be one of these.

| Constant | Values |
|---|---|
| `ATT_STATUSES` | `scheduled`, `in_progress`, `worked`, `cancelled` |
| `BONUS_STATUSES` | `proposed`, `pending`, `paid`, `cancelled` |
| `BONUS_TYPES` | `bonus`, `commission`, `incentive`, `deduction`, `tip`, `adjustment` |
| `CASH_HANDOVER_STATUSES` | `recorded`, `voided` |
| `COMPANIES` | `cstore`, `vape` |
| `ITEM_TYPES` | `shift`, `bonus` |
| `ORDER_CATEGORIES` | `Grocery`, `Cigarettes`, `Vapes`, `Other` |
| `PAYMENT_METHODS` | `cash`, `bank`, `etransfer`, `other` |
| `PRODUCT_CATEGORIES` | `vape`, `cigarettes`, `beer`, `grocery`, `other` |
| `ROLES` | `admin`, `manager`, `employee`, `payroll_admin` |
| `RULE_APPLIES` | `all_staff`, `specific_staff` |
| `RULE_TYPES` | `percentage`, `fixed` |
| `SHOPPING_STATUSES` | `pending`, `bought`, `cleared`, `removed` |
| `TILL_STATUSES` | `open`, `closed`, `validated` |
| `VARIANCE_STATUSES` | `OK`, `minor`, `investigate`, `pending_validation` |

Tab names are `SHEETS.*`; their columns are in the [schema reference](schema.md).

## Module APIs

### Attendance

`src/Attendance.gs` · per-day workday records (payroll source of truth)

`getAll()` · `getById(attendanceId)` · `getForStaff(staffId)` · `getForDateAndStaff(dateObj, staffId)` · `getForDateRange(startDate, endDate, filterStaffId)` · `getUnpaidForStaff(staffId)` · `openOrPromote(staffId, dateObj, actorId, now)` · `schedule(input)` · `complete(attendanceId, now, actorId)` · `cancel(attendanceId, actorId, reason)` · `editActualTimes(attendanceId, newStart, newEnd, actorId)` · `scheduledHours(att)` · `actualHours(att)` · `adjustHours(attendanceId, basis, actorId)`

### AuditLog

`src/AuditLog.gs` · append-only event log

`write(entry)` · `writeMany(entries)` · `recent(limit, filters)`

### Auth

`src/Auth.gs` · login, session tokens, role guards

`login(name, code)` · `logout(token)` · `peek(token)` · `validate(token)` · `require(session, allowedRoles)`

### Bonuses

`src/Bonuses.gs` · bonuses, commissions, adjustments

`create(input)` · `propose(input)` · `approve(bonusId, actorId)` · `cancel(bonusId, actorId, reason)` · `markPaid(bonusId, actorId)` · `revertToPending(bonusId, actorId)` · `getById(bonusId)` · `getForStaff(staffId, statusFilter)` · `getProposed()` · `getAll()` · `existsCommissionFor(staffId, company, periodStart, periodEnd, opts)`

### CashHandling

`src/CashHandling.gs` · cash in a cashier's hands, until it isn't

`sheetsExist()` · `cashManager()` · `getOutstandingForStaff(staffId)` · `getAllOutstanding()` · `getHistory(limit, staffId)` · `getPosition(staffId, privileged)` · `record(input)` · `voidHandover(handoverId, actorId)`

### Clover

`src/Clover.gs` · Clover REST API client (card totals for a day)

`isEnabled()` · `merchantFor(company)` · `getCardTotals(merchant, startMs, endMs)`

### CommissionRules

`src/CommissionRules.gs` · CRUD for commission_rules tab

`getAll()` · `getById(ruleId)` · `getActiveOn(forDate)` · `getRulesFor(staffId, company, forDate)` · `create(input)` · `update(input)` · `deactivate(ruleId, actorId)` · `RULE_TYPES`

### Commissions

`src/Commissions.gs` · weekly commission engine + Monday trigger

`runForWeek(input)` · `runForPreviousWeek(actorId, force)` · `getAllRuns()` · `findRunForWeek(weekStart)` · `installWeeklyTrigger()` · `removeWeeklyTrigger()` · `isTriggerInstalled()`

### Notifier

`src/Notifier.gs` · WhatsApp Cloud API sends + internal event log

`notify(event, payload)` · `sendWhatsApp(body)` · `sendTemplate(templateName, params)` · `sendOp(opKey, params, plain)`

### OrderCatalog

`src/OrderCatalog.gs` · master list of orderable items

`getAll()` · `getById(itemId)` · `create(input)` · `deactivate(itemId, actorId)`

### Payments

`src/Payments.gs` · payment recording, two distinct flows

`payShifts(input)` · `payBonus(input)` · `undo(paymentId, actorId)` · `undoLastForStaff(staffId, actorId)` · `getOwedSummary(staffId)` · `getPaymentById(paymentId)` · `getPaymentsForStaff(staffId)` · `getItemsForPayment(paymentId)` · `getRecent(limit)` · `getAllPayments()` · `getAllItems()` · `getAttendancePaidAmounts(attendanceIds)` · `getBonusPaidAmounts(bonusIds)`

### ProductMaster

`src/ProductMaster.gs` · thin CORE catalog of products

`getAll()` · `getAllIncludingInactive()` · `getById(productId)` · `getWithDetail(productId)` · `getBySku(sku)` · `search(query, opts)` · `create(input, opts)` · `update(productId, patch, actorId, opts)` · `deactivate(productId, actorId)` · `reactivate(productId, actorId)` · `importFromStaging(opts)` · `stagingLayout(type)` · `stagingSheetName(type)` · `computeMargin(costPrice, sellPrice)` · `readDetail(productId, category)` · `VALID_CATEGORIES` · `_cacheStats()` · `_bustCache()`

### ProductTypes

`src/ProductTypes.gs` · per-product-type registry

`has(category)` · `get(category)` · `detailSheet(cat)` · `detailColumns(cat)` · `inputColumns(category)` · `numericColumns(category)` · `keyFields(cat)` · `unitFrom(cat)` · `derivePricing(cat, detail)` · `validate(cat, detail)` · `schemaFor(category)` · `SYSTEM_DETAIL_COLS`

### PublicReport

`src/PublicReport.gs` · the 7-day report served outside the app

`build(days)` · `buildSales(days)`

### Reconcile

`src/Reconcile.gs` · per-shift cashier vs Clover reconciliation

`reconcileDay(actorId, mode)` · `getRecent(limit)` · `hasOpenSessionsToday()`

### Sales

`src/Sales.gs` · sales rows (one per till_session)

`getAll()` · `getForSession(sessionId)` · `getForDateRange(startDate, endDate, filters)` · `write(input, actorId)` · `totalForRow(row)` · `aggregateByStaffCompany(startDate, endDate)` · `getDashboard(input)` · `cardSplitFor(company)`

### Setup

`src/Setup.gs` · first-time schema creation + menu + placeholders

`onOpen()` · `menu_importBeer()` · `menu_importCigarettes()` · `menu_importVape()` · `menu_importOther()` · `menu_importProductType_(type, label)` · `menu_refreshStagingHeaders()` · `menu_diagnoseVapeStaging()` · `diagnoseStaging_(type)` · `menu_migrateFixedCommissionRules()` · `menu_migrateProductMasterNeedsDetail()` · `menu_migrateProductMasterV2()` · `menu_runCommissionEngine()` · `menu_installCommissionTrigger()` · `menu_removeCommissionTrigger()` · `firstTimeSetup()` · `configDefaults_()` · `setupConfigSheet_()` · `syncConfigKeys_()` · `menu_syncConfigKeys()` · `setupStaffSheet_()` · `setupAttendanceSheet_()` · `setupTillSessionsSheet_()` · `setupSalesSheet_()` · `setupPaymentsSheet_()` · `setupPaymentItemsSheet_()` · `setupBonusesSheet_()` · `setupCommissionRulesSheet_()` · `setupCommissionRunsSheet_()` · `setupAuditLogSheet_()` · `setupPosExtractedSheet_()` · `setupCloverBatchesSheet_()` · `setupValidationResultsSheet_()` · `setupSuppliersSheet_()` · `setupOrderCatalogSheet_()` · `setupProductMasterSheet_()` · `setupProductDetailSheet_(category, sheetName, title)` · `setupProductBeerDetailSheet_()` · `setupProductCigDetailSheet_()` · `setupProductVapeDetailSheet_()` · `setupTypeStagingSheet_(type, sheetName, title)` · `setupBeerStagingSheet_()` · `setupCigStagingSheet_()` · `setupVapeStagingSheet_()` · `setupOtherStagingSheet_()` · `setupShoppingListSheet_()` · `menu_migrateShoppingListProductId()` · `setupCashHandoversSheet_()` · `setupCashHandoverItemsSheet_()` · `menu_migrateCashHandling()` · `menu_migrateTillSessionsLottoReserve()` · `menu_migrateSalesCardTotal()` · `writeHeader_(sh, title, cols)` · `writeColumnHeaders_(sh, names)` · `applyEnumValidation_(sh, col, options)` · `applyBoolValidation_(sh, col)` · `setColWidths_(sh, widths)` · `resetDataTables()`

### ShoppingList

`src/ShoppingList.gs` · shared "to order" list + generation

`getPending()` · `getActive()` · `getById(entryId)` · `add(input)` · `edit(input)` · `removeEntry(entryId, actorId)` · `setBought(entryId, bought, actorId)` · `clearAll(actorId)` · `generate(actorId)`

### Staff

`src/Staff.gs` · staff roster operations

`getAll()` · `getActive()` · `getById(staffId)` · `getByName(name)` · `verifyLoginCode(staffId, submittedCode)` · `create(input)`

### Suppliers

`src/Suppliers.gs` · supplier reference (read-only in app)

`getAll()` · `getById(supplierId)`

### TillSessions

`src/TillSessions.gs` · per-company cash reconciliation

`getAll()` · `getById(sessionId)` · `getForAttendance(attendanceId)` · `getOpenForCompany(company)` · `getOpenForStaff(staffId)` · `getForDateRange(startDate, endDate, filterCompany)` · `open(input)` · `close(input)` · `edit(input)` · `getExpectedFloat(company)` · `getVarianceStatus(variance)` · `getLottoExpected()` · `getLottoLog(days)` · `lottoCompany`

### Util

`src/Util.gs` · date/ID/money/parsing helpers (no sheet access)

`todayMidnight()` · `endOfDay(d)` · `formatDate(d)` · `formatDateTime(d)` · `parseDate(yyyyMmDd)` · `addDays(d, days)` · `getMondayOf(d)` · `getPreviousWeekRange(now)` · `diffHours(start, end)` · `newId(prefix)` · `attendanceId(dateObj, staffId)` · `tillSessionId(dateObj, staffId, company)` · `newToken()` · `newLoginCode(digits)` · `roundMoney(n)` · `moneyEquals(a, b, tolerance)` · `formatMoney(n)` · `parseTimeRange(value)` · `formatTimeHHMM(hour, min)`

### WebApp

`src/WebApp.gs` · HTTP entry point + RPC layer

`doGet(e)` · `inlineJson_(obj)` · `publicReconPage_(e)` · `publicSalesPage_(e)` · `_session(token)` · `_staffNameMap()` · `_enrichStaffNames(rows)` · `_rpcGetMyShiftState(token)` · `num_(v)` · `_isCashPrivileged(session)` · `debugCommissionRules()` · `serializeProduct_(r)` · `serializeDetail_(d)` · `debugProductMasterCache()` · `debugProductMaster()`
