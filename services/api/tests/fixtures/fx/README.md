# Sanitized FX adapter fixtures

These minimal fixtures preserve the selectors, JSON field names, reference series order,
and Spanish date format recorded in the September 29 source-validation research.
They are deliberately reduced contract examples, not complete archived responses.
Prices are test values. Extra comparator, selected-direction, discount, and secret-marker
fields exercise exclusion; no real token, cookie, user, or admin payload is stored.

Kambista and Securex were updated on November 23 to reduced JSON contracts from
the public endpoints used by their homepages. Kambista uses a non-committing
USD 100 calculation; Securex requests standard rates without a coupon. Their
HTML defaults are not accepted as live quotes. Tests in `test_fx_live_contracts.py`
cover endpoint/method selection, invalid data, and Cambio Seguro's gzip transport.
