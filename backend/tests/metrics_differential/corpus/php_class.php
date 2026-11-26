<?php
namespace App\Billing;

final class Invoice
{
    private array $lines = [];

    public function __construct(private string $currency = 'EUR') {}

    public function add(string $item, float $price, int $qty = 1): self
    {
        if ($price < 0 || $qty <= 0) {
            throw new \InvalidArgumentException("bad line {$item}");
        }
        $this->lines[] = compact('item', 'price', 'qty');
        return $this;
    }

    public function total(): float
    {
        $sum = 0.0;
        foreach ($this->lines as $line) {
            $sum += $line['price'] * $line['qty'];
        }
        return $sum;
    }

    public function label(int $code): string
    {
        return match ($code) {
            1, 2 => 'small',
            3 => $code > 2 ? 'mid' : 'odd',
            default => 'large',
        };
    }

    public static function parse(?string $raw): ?self
    {
        $raw = $raw ?: null;
        $mapper = fn ($x) => $x * 2;
        $cb = function ($v) use ($mapper) {
            return $mapper($v) ?? 0;
        };
        return $raw === null ? null : new self();
    }
}
