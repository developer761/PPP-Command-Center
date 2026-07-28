# AIA export → Katie's "Blank AIA Requisition.xls" cell map

Source: `Blank AIA Requisition.xls` (Frank C. Mauro / AIA G702 & G703). Two sheets.
The Excel export (H3) fills these cells. We write **hard computed values** (from
`resolveG702` + the G703 line items) into the value cells so the file is correct
regardless of the template's formula state. Convert the .xls → .xlsx once and
keep it as the fill template (exceljs reads/writes .xlsx, preserves styling).

## Sheet 1 — "Loan G-702" (summary certificate)
| Cell | Field |
|---|---|
| I4  | Application No. |
| D3  | Project (deal name / property) |
| A3 (below) | Owner (GC / account) |
| A10 (below) | Contractor (PPP) |
| I7  | Period To (Excel date serial) |
| H16 (value) | Contract date |
| **E24** | 1. Original Contract Sum |
| **E25** | 2. Net change by Change Orders (signed) |
| **E26** | 3. Contract Sum to Date |
| **E27** | 4. Total Completed & Stored to Date |
| **B30** | retainage % rate (e.g. 5) |
| **D30** | 5a. retainage on completed work $ |
| **(5b)** | retainage on stored material $ (row 32/33) |
| **E35** | 5. Total Retainage |
| **E36** | 6. Total Earned Less Retainage |
| **E39** | 7. Less Previous Certificates |
| **E40** | 8. Current Payment Due |
| **E41** | 9. Balance to Finish incl. Retainage |
| D46/E46 | CO summary — approved previous months (add/deduct) |
| D48/E48 | CO summary — approved this month (add/deduct) |
| D50/E50 | CO summary — totals |
| D51 | CO summary — net change |

## Sheet 2 — "G-703 Total Hard Cost" (continuation sheet)
Header: I2 = Application No · I3 = Application Date · I4 = Period To · J10 = retainage rate (0.05).
Data rows **13–33** (~21 line slots), grand totals row **35**.

| Col | AIA | Field |
|---|---|---|
| A | A | Item no. |
| B | B | Description of work |
| C | C | Scheduled Value |
| D | D | Work completed FROM PREVIOUS application |
| E | E | Work completed THIS PERIOD |
| F | F | Materials presently stored (not in D/E) |
| G | G | Total completed & stored to date (D+E+F) |
| H | H | % (G ÷ C) |
| I | I | Balance to finish (C − G) |
| J | (ret) | Retainage |

Grand totals (row 35): C35 = Σ scheduled · E35 = Σ this-period (or D+E) · G35 = Σ total · J35 = Σ retainage.
