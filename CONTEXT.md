# Edicius HQ

Private tools for personal finance, markets, and fare tracking. This glossary records
the product language shared across its features.

## Airfare

**Airfare archive**:
The owner's durable historical record on the Pi: full observations for flights
that have not departed, plus immutable numeric summaries for departed flights.
It is not a disposable market-data cache.
_Avoid_: fare cache, source copy

**Airfare replica**:
An indexed copy of active Airfare detail and departed summaries used to answer
reads. It does not become the write authority merely by being synchronized.
_Avoid_: primary archive, collector store

**Departure summary**:
An immutable numeric partition for one departed flight date. It retains exact
price frequencies, provider context, health and the minimum needed for historical
charts and pair reference without retaining old offers.
_Avoid_: archived flight, approximate monthly median

**Watch**:
A selected city pair and departure month that is eligible for fare collection.
_Avoid_: route subscription

**Fare snapshot**:
A point-in-time set of offers for one city pair and departure date.
_Avoid_: live fare, current price

**Baseline point**:
A dated provider price for a city pair and departure date, used as historical
reference data.
_Avoid_: snapshot

**Calendar capture**:
A point-in-time fare curve covering a range of departure dates for a city pair.
_Avoid_: calendar snapshot

**Collection pass**:
A bounded attempt to collect due Airfare observations.
_Avoid_: sync run

**Pair reference**:
The whole-pair median of each departure date's cheapest observed fare, with the
number of represented departure dates.
_Avoid_: watched-month median

## FX

**FX observation**:
One accepted USD/PEN rate for a source, effective time and observation time.
_Avoid_: poll attempt, provider response

**FX archive**:
The durable owner history of accepted FX observations on the Pi after a verified
cutover. An observation remains in this history after remote acknowledgement.
_Avoid_: outbox, temporary cache

**FX replica**:
The remote copy of the FX archive used for web reads. Its equality with the Pi
archive is established by complete keys and content, not only row counts.
_Avoid_: historical authority
