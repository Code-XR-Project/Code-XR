<?php
function legacy_sum($values)
{
    $total = 0;
    for ($i = 0; $i < count($values); $i++) {
        if (is_numeric($values[$i]) and $values[$i] > 0) {
            $total += $values[$i];
        } elseif ($values[$i] === null) {
            continue;
        }
    }
    return $total;
}
?>
<p>Total: <?php echo legacy_sum(array(1, 2)); ?></p>
