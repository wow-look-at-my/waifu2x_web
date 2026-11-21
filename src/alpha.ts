// alpha.ts holds bleedColour.

const NEIGHBOURS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

// Gives each fully transparent pixel near a visible one the mean colour of its
// visible neighbours. Without this, the network pulls black into the edges.
export function bleedColour(data: Uint8ClampedArray, w: number, h: number, rounds: number): void {
    const EMPTY = 0, FILLED = 1, QUEUED = 2;
    const state = new Uint8Array(w * h);
    for (let i = 0; i < state.length; i++) {
        if (data[i * 4 + 3] !== 0) state[i] = FILLED;
    }

    const queueEmptyAround = (p: number, queue: number[]) => {
        const x = p % w, y = (p - x) / w;
        for (const [dx, dy] of NEIGHBOURS) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const q = ny * w + nx;
            if (state[q] === EMPTY) {
                state[q] = QUEUED;
                queue.push(q);
            }
        }
    };

    let frontier: number[] = [];
    for (let p = 0; p < state.length; p++) {
        if (state[p] === FILLED) queueEmptyAround(p, frontier);
    }

    for (let round = 0; round < rounds && frontier.length > 0; round++) {
        const colours = new Uint8Array(frontier.length * 3);
        for (let i = 0; i < frontier.length; i++) {
            const p = frontier[i];
            const x = p % w, y = (p - x) / w;
            let r = 0, g = 0, b = 0, count = 0;
            for (const [dx, dy] of NEIGHBOURS) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const q = ny * w + nx;
                if (state[q] !== FILLED) continue;
                r += data[q * 4];
                g += data[q * 4 + 1];
                b += data[q * 4 + 2];
                count++;
            }
            colours[i * 3] = r / count;
            colours[i * 3 + 1] = g / count;
            colours[i * 3 + 2] = b / count;
        }

        // State changes only after every mean is taken, so one round reads one ring.
        for (let i = 0; i < frontier.length; i++) {
            const p = frontier[i];
            data[p * 4] = colours[i * 3];
            data[p * 4 + 1] = colours[i * 3 + 1];
            data[p * 4 + 2] = colours[i * 3 + 2];
        }
        for (const p of frontier) state[p] = FILLED;

        const next: number[] = [];
        for (const p of frontier) queueEmptyAround(p, next);
        frontier = next;
    }
}
