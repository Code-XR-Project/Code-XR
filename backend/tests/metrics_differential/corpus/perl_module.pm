package Hard::Counter;
use strict;
use warnings;

sub new {
    my ($class, %args) = @_;
    my $self = { count => $args{start} // 0 };
    return bless $self, $class;
}

sub add {
    my ($self, $n) = @_;
    die "negative" if $n < 0;
    $self->{count} += $n unless $n == 0;
    return $self->{count};
}

sub summary {
    my $self = shift;
    foreach my $key (sort keys %$self) {
        if ($key =~ /^c/ && defined $self->{$key}) {
            print "$key\n";
        }
    }
    return $self->{count} > 10 ? 'big' : 'small';
}

1;
