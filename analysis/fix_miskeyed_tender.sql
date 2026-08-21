/*  Repair mis-keyed cash-tendered amounts in RetailPOS_DB.
 *
 *  Symptom: a cashier typed a cash-tendered figure with extra digits, e.g.
 *  $804,906,004,014.00 taken against a $20.00 sale. The bad value lands in
 *  Invoice_Payment.Amount and InvoiceInfo.Cash, and the derived change in
 *  InvoiceInfo.Change. GrandTotal is NOT affected, so reported sales were
 *  always correct -- only cash/tender reports were wrong.
 *
 *  Fix: set tendered = the actual sale amount and change = 0, which is what
 *  the till should have recorded for an exact-payment transaction.
 *
 *  Rows are selected by RULE, not by hardcoded ID, so this stays correct if
 *  run later or against a different backup. A row qualifies only when the
 *  tender is both absurd in absolute terms (> $10,000) and wildly out of
 *  line with its own sale (> $500 over GrandTotal). Legitimate large tenders
 *  -- a $500 note against a $450 sale -- do not qualify.
 *
 *  Safe to re-run: once repaired, rows no longer match the rule.
 *
 *  Usage:  sqlcmd -S <server> -d RetailPOS_DB -i fix_miskeyed_tender.sql
 *  Take a backup first.
 */

SET NOCOUNT ON;
USE RetailPOS_DB;
GO

DECLARE @AbsurdTender money = 10000.00;   -- no single cash tender is this large
DECLARE @OverSaleBy   money =   500.00;   -- ...and this far above its own sale

IF OBJECT_ID('tempdb..#bad') IS NOT NULL DROP TABLE #bad;

SELECT  i.Inv_ID,
        i.InvoiceNo,
        i.InvoiceDate,
        i.GrandTotal,
        i.Cash        AS OldCash,
        i.[Change]    AS OldChange
INTO    #bad
FROM    InvoiceInfo i
WHERE   i.Cash > @AbsurdTender
  AND   i.Cash > i.GrandTotal + @OverSaleBy;

IF NOT EXISTS (SELECT 1 FROM #bad)
BEGIN
    PRINT 'No mis-keyed tender rows found -- nothing to do.';
    RETURN;
END

PRINT '--- Rows to repair ---';
SELECT Inv_ID, InvoiceNo, InvoiceDate, GrandTotal, OldCash, OldChange FROM #bad ORDER BY Inv_ID;

BEGIN TRY
    BEGIN TRANSACTION;

    /* 1. Invoice header: tendered becomes the sale amount, no change given. */
    UPDATE  i
    SET     i.Cash     = i.GrandTotal,
            i.[Change] = 0
    FROM    InvoiceInfo i
    JOIN    #bad b ON b.Inv_ID = i.Inv_ID;

    PRINT 'InvoiceInfo rows updated:  ' + CAST(@@ROWCOUNT AS varchar(10));

    /* 2. Payment line. These invoices each carry a single cash payment, so the
     *    whole sale amount belongs to it. Guard on PaymentMode anyway, and only
     *    touch the payment that actually holds the absurd figure. */
    UPDATE  p
    SET     p.Amount = b.GrandTotal
    FROM    Invoice_Payment p
    JOIN    #bad b ON b.Inv_ID = p.InvoiceID
    WHERE   RTRIM(p.PaymentMode) = 'Cash'
      AND   p.Amount > @AbsurdTender;

    PRINT 'Invoice_Payment rows updated: ' + CAST(@@ROWCOUNT AS varchar(10));

    /* 3. Refuse to commit if any invoice is left with payments that do not
     *    cover its sale -- that would mean an invoice had more than one
     *    payment line and this script picked the wrong one. */
    IF EXISTS (
        SELECT 1
        FROM   #bad b
        JOIN   InvoiceInfo i ON i.Inv_ID = b.Inv_ID
        LEFT   JOIN (SELECT InvoiceID, SUM(Amount) AS Paid
                     FROM Invoice_Payment GROUP BY InvoiceID) p
               ON p.InvoiceID = b.Inv_ID
        WHERE  ABS(ISNULL(p.Paid, 0) - i.GrandTotal) > 0.01
    )
    BEGIN
        RAISERROR('Post-check failed: a repaired invoice no longer balances against its payments. Rolling back.', 16, 1);
    END

    COMMIT TRANSACTION;
    PRINT 'Committed.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    PRINT 'ROLLED BACK: ' + ERROR_MESSAGE();
    RETURN;
END CATCH
GO

/* Verification: the repaired invoices, and the resulting cash total. */
PRINT '--- After repair ---';
SELECT  i.Inv_ID, i.GrandTotal, i.Cash, i.[Change], p.Amount AS PaymentAmount
FROM    InvoiceInfo i
JOIN    Invoice_Payment p ON p.InvoiceID = i.Inv_ID
WHERE   i.Inv_ID IN (SELECT Inv_ID FROM #bad)
ORDER BY i.Inv_ID;

SELECT  RTRIM(PaymentMode) AS PaymentMode,
        COUNT(*)           AS Payments,
        SUM(Amount)        AS Total
FROM    Invoice_Payment
GROUP BY RTRIM(PaymentMode)
ORDER BY SUM(Amount) DESC;
GO
