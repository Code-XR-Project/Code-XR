const test = require('node:test');
const assert = require('node:assert/strict');
const { InstallProgress } = require('../../out/core/python-env/installProgress.js');

function recorder() {
    const reports = [];
    let total = 0;
    return {
        reports,
        get total() { return total; },
        report(value) {
            reports.push(value);
            if (typeof value.increment === 'number') {
                total += value.increment;
            }
        },
    };
}

test('InstallProgress turns milestones into increments that add up to the milestone', () => {
    const sink = recorder();
    const messages = [];
    const progress = new InstallProgress(sink, message => messages.push(message));
    for (const [percent, message] of [[0, 'a'], [20, 'b'], [55, 'c'], [70, 'd'], [80, 'e'], [95, 'f'], [100, 'g']]) {
        progress.to(percent, message);
        assert.equal(sink.total, percent);
    }
    assert.deepEqual(messages, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    assert.equal(progress.percent, 100);
});

test('InstallProgress never moves back nor past 100', () => {
    const sink = recorder();
    const progress = new InstallProgress(sink);
    progress.to(60, 'x');
    progress.to(30, 'back');
    assert.deepEqual(sink.reports.at(-1), { message: 'back' });
    progress.to(250, 'over');
    assert.equal(sink.total, 100);
    progress.message('done');
    assert.equal(sink.total, 100);
});

test('InstallProgress.span shares a window between steps so the bar keeps moving', () => {
    const sink = recorder();
    const progress = new InstallProgress(sink);
    progress.to(80, 'packages');
    const step = progress.span(80, 95, 5);
    const seen = [];
    for (let index = 0; index < 5; index++) {
        step(index, `step ${index}`);
        seen.push(sink.total);
    }
    assert.deepEqual(seen, [80, 83, 86, 89, 92]);
    progress.to(95, 'next');
    assert.equal(sink.total, 95);
});
