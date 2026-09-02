-- 175 · Suffolk County sales tax is 8.75%, not 8.625%.
--
-- Stephanie 2026-09-01: "Tax rates are different between Nassau (8.625%) and
-- Suffolk (8.75%)."
--
-- The table had both counties at 8.625%. Tomco is in Central Islip, so Suffolk
-- is most of their work — six of the nine live jobs carry a Suffolk ZIP.
--
-- Nothing has been mis-billed: no invoice on a Suffolk job has charged tax yet,
-- so this corrects the rate before it is ever applied rather than after. Had
-- there been billed invoices, this migration would NOT have been the fix — a
-- rate change does not reissue a document already sent to a GC.
--
-- Rates are stored as thousandths of a percent so common NY combined rates stay
-- exact integers: 8.75% = 8750.
--
-- Nassau is deliberately untouched at 8.625%, and NYC at 8.875%, both of which
-- she confirmed.
UPDATE commercial_tax_jurisdictions
   SET combined_rate_thou = 8750,
       updated_at = now()
 WHERE name = 'Suffolk County'
   AND combined_rate_thou = 8625;
