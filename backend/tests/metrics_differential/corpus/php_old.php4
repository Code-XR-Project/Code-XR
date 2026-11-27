<?php
class Counter
{
    var $count = 0;

    function increment($step)
    {
        while ($step-- > 0) {
            $this->count++;
        }
        return $this->count;
    }
}
?>
