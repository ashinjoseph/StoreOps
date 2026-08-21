#!/usr/bin/env bash
# Write aggregate extracts from a restored RetailPOS_DB into ./data.
# Requires ./restore.sh to have been run first.
set -euo pipefail

SA_PASS="${SA_PASS:-Str0ng!Passw0rd#2026}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/data"
mkdir -p "$OUT"
Q() { docker exec sqlsrv /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$SA_PASS" -C -h-1 -W -s"|" -Q "SET NOCOUNT ON; USE RetailPOS_DB; $1" 2>&1 | grep -v "^Changed database" | sed '/^$/d' | sed '/rows affected/d'; }

# 1. Daily
Q "SELECT CONVERT(varchar(10),i.InvoiceDate,120),
 CAST(COUNT(DISTINCT i.Inv_ID) AS varchar),
 CAST(CAST(SUM(CASE WHEN ISNULL(RTRIM(pr.Category),'')<>'LOTTERY' THEN ip.TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar),
 CAST(CAST(SUM(CASE WHEN RTRIM(pr.Category)='LOTTERY' AND ip.TotalAmount>0 THEN ip.TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar),
 CAST(CAST(SUM(CASE WHEN RTRIM(pr.Category)='LOTTERY' AND ip.TotalAmount<0 THEN ip.TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar)
 FROM InvoiceInfo i JOIN Invoice_Product ip ON ip.InvoiceID=i.Inv_ID LEFT JOIN Product pr ON pr.PID=ip.ProductID
 GROUP BY CONVERT(varchar(10),i.InvoiceDate,120) ORDER BY 1;" > "$OUT"/daily.psv

# 2. Hour x DOW (retail only)
Q "SELECT CAST(DATEPART(weekday,i.InvoiceDate) AS varchar), CAST(DATEPART(hour,i.InvoiceDate) AS varchar),
 CAST(COUNT(DISTINCT i.Inv_ID) AS varchar),
 CAST(CAST(SUM(CASE WHEN ISNULL(RTRIM(pr.Category),'')<>'LOTTERY' THEN ip.TotalAmount ELSE 0 END) AS decimal(18,2)) AS varchar)
 FROM InvoiceInfo i JOIN Invoice_Product ip ON ip.InvoiceID=i.Inv_ID LEFT JOIN Product pr ON pr.PID=ip.ProductID
 GROUP BY DATEPART(weekday,i.InvoiceDate), DATEPART(hour,i.InvoiceDate) ORDER BY 1,2;" > "$OUT"/hour_dow.psv

# 3. Category
Q "SELECT ISNULL(RTRIM(pr.Category),'(uncategorized)'), CAST(COUNT(*) AS varchar),
 CAST(CAST(SUM(ip.TotalAmount) AS decimal(18,2)) AS varchar), CAST(CAST(SUM(ip.Qty) AS decimal(18,2)) AS varchar)
 FROM Invoice_Product ip LEFT JOIN Product pr ON pr.PID=ip.ProductID
 GROUP BY ISNULL(RTRIM(pr.Category),'(uncategorized)') ORDER BY SUM(ip.TotalAmount) DESC;" > "$OUT"/category.psv

# 4. Top products (retail only, exclude lottery)
Q "SELECT TOP 60 RTRIM(pr.ProductName), ISNULL(RTRIM(pr.Category),''), CAST(CAST(SUM(ip.Qty) AS decimal(18,2)) AS varchar),
 CAST(CAST(SUM(ip.TotalAmount) AS decimal(18,2)) AS varchar), CAST(COUNT(DISTINCT ip.InvoiceID) AS varchar)
 FROM Invoice_Product ip JOIN Product pr ON pr.PID=ip.ProductID
 WHERE ISNULL(RTRIM(pr.Category),'')<>'LOTTERY'
 GROUP BY RTRIM(pr.ProductName), ISNULL(RTRIM(pr.Category),'') ORDER BY SUM(ip.TotalAmount) DESC;" > "$OUT"/top_products.psv

# 5. Payment mix (exclude 3 corrupt)
Q "SELECT RTRIM(p.PaymentMode), CAST(COUNT(*) AS varchar), CAST(CAST(SUM(p.Amount) AS decimal(18,2)) AS varchar)
 FROM Invoice_Payment p WHERE p.InvoiceID NOT IN (13424,6795,17)
 GROUP BY RTRIM(p.PaymentMode) ORDER BY SUM(p.Amount) DESC;" > "$OUT"/payment.psv

# 6. Basket size buckets (retail)
Q "WITH b AS (SELECT i.Inv_ID, SUM(CASE WHEN ISNULL(RTRIM(pr.Category),'')<>'LOTTERY' THEN ip.TotalAmount ELSE 0 END) v
 FROM InvoiceInfo i JOIN Invoice_Product ip ON ip.InvoiceID=i.Inv_ID LEFT JOIN Product pr ON pr.PID=ip.ProductID GROUP BY i.Inv_ID)
 SELECT CASE WHEN v<=0 THEN '0 or less' WHEN v<2 THEN 'a. <\$2' WHEN v<5 THEN 'b. \$2-5' WHEN v<10 THEN 'c. \$5-10'
 WHEN v<20 THEN 'd. \$10-20' WHEN v<50 THEN 'e. \$20-50' ELSE 'f. \$50+' END, CAST(COUNT(*) AS varchar),
 CAST(CAST(SUM(v) AS decimal(18,2)) AS varchar) FROM b GROUP BY CASE WHEN v<=0 THEN '0 or less' WHEN v<2 THEN 'a. <\$2' WHEN v<5 THEN 'b. \$2-5' WHEN v<10 THEN 'c. \$5-10'
 WHEN v<20 THEN 'd. \$10-20' WHEN v<50 THEN 'e. \$20-50' ELSE 'f. \$50+' END ORDER BY 1;" > "$OUT"/basket.psv
echo OK
