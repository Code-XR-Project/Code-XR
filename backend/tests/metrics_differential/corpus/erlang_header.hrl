-record(point, {x = 0, y = 0}).

-define(MAX, 100).

clamp(V) when V > ?MAX -> ?MAX;
clamp(V) when V < 0 -> 0;
clamp(V) -> V.

dist(#point{x = X1, y = Y1}, #point{x = X2, y = Y2}) ->
    case {X2 - X1, Y2 - Y1} of
        {0, 0} -> 0;
        {DX, DY} -> math:sqrt(DX * DX + DY * DY)
    end.
