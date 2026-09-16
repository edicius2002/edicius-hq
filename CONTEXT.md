# Edicius HQ

Private tools for personal finance, markets, and fare tracking. This glossary records
the product language shared across its features.

## Airfare

**Airfare archive**:
The owner's durable historical record of fare observations. It is not a disposable
market-data cache.
_Avoid_: fare cache, source copy

**Airfare replica**:
An indexed copy of the Airfare archive used to answer reads. It does not become the
write authority merely by being synchronized.
_Avoid_: primary archive, collector store

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
