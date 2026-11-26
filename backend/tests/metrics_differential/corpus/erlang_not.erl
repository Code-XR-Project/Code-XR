-module(erlang_not).
-export([flip/1]).

flip(Flag) ->
    case not Flag of
        true -> on;
        false -> off
    end.
