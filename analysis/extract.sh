#!/usr/bin/env bash
# Extract the analysis datasets from a restored RetailPOS_DB into ./data.
# Requires ./restore.sh (and ideally fix_miskeyed_tender.sql) to have run first.
#
# Every query classifies a line item as LOTTERY or retail by the product
# master's Category. "Sales" throughout = retail + lottery net of payouts.
set -euo pipefail

SA_PASS="${SA_PASS:-Str0ng!Passw0rd#2026}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/data"
mkdir -p "$OUT"

Q() {
  docker exec sqlsrv /opt/mssql-tools18/bin/sqlcmd \
    -S localhost -U sa -P "$SA_PASS" -C -h-1 -W -s"|" \
    -Q "SET NOCOUNT ON; USE RetailPOS_DB; $1" 2>&1 \
  | grep -v "^Changed database" | sed '/^$/d' | sed '/rows affected/d'
}

# Reusable line-item view: every line tagged retail vs lottery, with its date.
LINES="WITH L AS (
  SELECT i.Inv_ID, i.InvoiceDate, ip.TotalAmount, ip.Qty,
         ISNULL(RTRIM(pr.Category),'(uncategorised)') AS Cat,
         RTRIM(ISNULL(pr.ProductName,'')) AS Pname,
         CASE WHEN RTRIM(ISNULL(pr.Category,''))='LOTTERY' THEN 1 ELSE 0 END AS IsLot
  FROM InvoiceInfo i
  JOIN Invoice_Product ip ON ip.InvoiceID = i.Inv_ID
  LEFT JOIN Product pr ON pr.PID = ip.ProductID
)"

echo "daily…"
Q "$LINES
SELECT CONVERT(varchar(10),InvoiceDate,120),
       CAST(COUNT(DISTINCT Inv_ID) AS varchar),
       CAST(CAST(SUM(CASE WHEN IsLot=0 THEN TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar),
       CAST(CAST(SUM(CASE WHEN IsLot=1 AND TotalAmount>0 THEN TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar),
       CAST(CAST(SUM(CASE WHEN IsLot=1 AND TotalAmount<0 THEN TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar),
       CAST(COUNT(DISTINCT CASE WHEN IsLot=0 THEN Inv_ID END) AS varchar),
       CAST(COUNT(DISTINCT CASE WHEN IsLot=1 THEN Inv_ID END) AS varchar)
FROM L GROUP BY CONVERT(varchar(10),InvoiceDate,120) ORDER BY 1;" > "$OUT"/daily.psv

echo "hour x weekday…"
Q "$LINES
SELECT CAST(DATEPART(weekday,InvoiceDate) AS varchar), CAST(DATEPART(hour,InvoiceDate) AS varchar),
       CAST(COUNT(DISTINCT Inv_ID) AS varchar),
       CAST(CAST(SUM(CASE WHEN IsLot=0 THEN TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar),
       CAST(CAST(SUM(CASE WHEN IsLot=1 THEN TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar)
FROM L GROUP BY DATEPART(weekday,InvoiceDate), DATEPART(hour,InvoiceDate) ORDER BY 1,2;" > "$OUT"/hour_dow.psv

echo "category totals…"
Q "$LINES
SELECT Cat, CAST(COUNT(*) AS varchar),
       CAST(CAST(SUM(TotalAmount) AS decimal(18,2)) AS varchar),
       CAST(CAST(SUM(Qty) AS decimal(18,2)) AS varchar),
       CAST(COUNT(DISTINCT Inv_ID) AS varchar)
FROM L GROUP BY Cat ORDER BY SUM(TotalAmount) DESC;" > "$OUT"/category.psv

echo "category x week…"
Q "$LINES
SELECT Cat, CONVERT(varchar(10), DATEADD(day, -(DATEPART(weekday,InvoiceDate)-1), CAST(InvoiceDate AS date)), 120),
       CAST(CAST(SUM(TotalAmount) AS decimal(18,2)) AS varchar)
FROM L GROUP BY Cat, DATEADD(day, -(DATEPART(weekday,InvoiceDate)-1), CAST(InvoiceDate AS date))
ORDER BY 1,2;" > "$OUT"/cat_week.psv

echo "weekday profile…"
Q "$LINES
SELECT CAST(DATEPART(weekday,InvoiceDate) AS varchar),
       CAST(COUNT(DISTINCT CAST(InvoiceDate AS date)) AS varchar),
       CAST(COUNT(DISTINCT Inv_ID) AS varchar),
       CAST(CAST(SUM(CASE WHEN IsLot=0 THEN TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar),
       CAST(CAST(SUM(CASE WHEN IsLot=1 THEN TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar)
FROM L GROUP BY DATEPART(weekday,InvoiceDate) ORDER BY 1;" > "$OUT"/dow.psv

echo "basket mix (lottery vs retail per invoice)…"
Q "WITH B AS (
  SELECT i.Inv_ID,
         MAX(CASE WHEN RTRIM(ISNULL(pr.Category,''))='LOTTERY' THEN 1 ELSE 0 END) AS HasLot,
         MAX(CASE WHEN RTRIM(ISNULL(pr.Category,''))<>'LOTTERY' THEN 1 ELSE 0 END) AS HasRet,
         SUM(CASE WHEN RTRIM(ISNULL(pr.Category,''))<>'LOTTERY' THEN ip.TotalAmount ELSE 0 END) AS RetVal
  FROM InvoiceInfo i JOIN Invoice_Product ip ON ip.InvoiceID=i.Inv_ID
  LEFT JOIN Product pr ON pr.PID=ip.ProductID GROUP BY i.Inv_ID)
SELECT CASE WHEN HasLot=1 AND HasRet=1 THEN 'both'
            WHEN HasLot=1 THEN 'lottery only' ELSE 'retail only' END,
       CAST(COUNT(*) AS varchar),
       CAST(CAST(SUM(RetVal) AS decimal(18,2)) AS varchar)
FROM B GROUP BY CASE WHEN HasLot=1 AND HasRet=1 THEN 'both'
                     WHEN HasLot=1 THEN 'lottery only' ELSE 'retail only' END;" > "$OUT"/attach.psv

echo "basket size buckets…"
Q "WITH B AS (
  SELECT i.Inv_ID, SUM(CASE WHEN RTRIM(ISNULL(pr.Category,''))<>'LOTTERY' THEN ip.TotalAmount ELSE 0 END) v
  FROM InvoiceInfo i JOIN Invoice_Product ip ON ip.InvoiceID=i.Inv_ID
  LEFT JOIN Product pr ON pr.PID=ip.ProductID GROUP BY i.Inv_ID)
SELECT CASE WHEN v<=0 THEN 'none' WHEN v<2 THEN 'a' WHEN v<5 THEN 'b' WHEN v<10 THEN 'c'
            WHEN v<20 THEN 'd' WHEN v<50 THEN 'e' ELSE 'f' END,
       CAST(COUNT(*) AS varchar), CAST(CAST(SUM(v) AS decimal(18,2)) AS varchar)
FROM B GROUP BY CASE WHEN v<=0 THEN 'none' WHEN v<2 THEN 'a' WHEN v<5 THEN 'b' WHEN v<10 THEN 'c'
            WHEN v<20 THEN 'd' WHEN v<50 THEN 'e' ELSE 'f' END ORDER BY 1;" > "$OUT"/basket.psv

echo "payment mix by month…"
Q "SELECT RTRIM(p.PaymentMode), CONVERT(varchar(7), i.InvoiceDate, 120),
       CAST(COUNT(*) AS varchar), CAST(CAST(SUM(p.Amount) AS decimal(18,2)) AS varchar)
FROM Invoice_Payment p JOIN InvoiceInfo i ON i.Inv_ID=p.InvoiceID
GROUP BY RTRIM(p.PaymentMode), CONVERT(varchar(7), i.InvoiceDate, 120) ORDER BY 1,2;" > "$OUT"/payment_month.psv

echo "payment totals…"
Q "SELECT RTRIM(PaymentMode), CAST(COUNT(*) AS varchar), CAST(CAST(SUM(Amount) AS decimal(18,2)) AS varchar)
FROM Invoice_Payment GROUP BY RTRIM(PaymentMode) ORDER BY SUM(Amount) DESC;" > "$OUT"/payment.psv

echo "top products…"
Q "$LINES
SELECT TOP 80 Pname, Cat, CAST(CAST(SUM(Qty) AS decimal(18,2)) AS varchar),
       CAST(CAST(SUM(TotalAmount) AS decimal(18,2)) AS varchar), CAST(COUNT(DISTINCT Inv_ID) AS varchar)
FROM L WHERE IsLot=0 GROUP BY Pname, Cat ORDER BY SUM(TotalAmount) DESC;" > "$OUT"/top_products.psv

echo "product movers (first 42 days vs last 42 days)…"
Q "DECLARE @mn date, @mx date;
SELECT @mn = MIN(CAST(InvoiceDate AS date)), @mx = MAX(CAST(InvoiceDate AS date)) FROM InvoiceInfo;
DECLARE @e1 date = DATEADD(day, 41, @mn), @s2 date = DATEADD(day, -41, @mx);
$LINES
SELECT Pname, Cat,
  CAST(CAST(SUM(CASE WHEN CAST(InvoiceDate AS date) <= @e1 THEN TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar),
  CAST(CAST(SUM(CASE WHEN CAST(InvoiceDate AS date) >= @s2 THEN TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar)
FROM L WHERE IsLot=0 GROUP BY Pname, Cat
HAVING SUM(TotalAmount) > 250 ORDER BY SUM(TotalAmount) DESC;" > "$OUT"/movers.psv

echo "lottery daily…"
Q "$LINES
SELECT CONVERT(varchar(10),InvoiceDate,120),
  CAST(CAST(SUM(CASE WHEN TotalAmount>0 THEN TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar),
  CAST(CAST(SUM(CASE WHEN TotalAmount<0 THEN -TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar),
  CAST(COUNT(DISTINCT Inv_ID) AS varchar)
FROM L WHERE IsLot=1 GROUP BY CONVERT(varchar(10),InvoiceDate,120) ORDER BY 1;" > "$OUT"/lottery_daily.psv

echo "lottery product split…"
Q "$LINES
SELECT Pname, CAST(COUNT(*) AS varchar), CAST(CAST(SUM(TotalAmount) AS decimal(18,2)) AS varchar)
FROM L WHERE IsLot=1 GROUP BY Pname ORDER BY SUM(TotalAmount) DESC;" > "$OUT"/lottery_products.psv

echo "done -> $OUT"
