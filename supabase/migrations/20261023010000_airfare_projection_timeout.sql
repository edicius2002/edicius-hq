-- AQP-LIM's route projection exceeded the previous 30-second function limit
-- after a release replayed its baseline. The REST API permits up to 60 seconds.
alter function public.refresh_fare_route_projection(text, text)
  set statement_timeout = '60s';
