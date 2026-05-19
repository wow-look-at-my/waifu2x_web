#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_input;
uniform sampler2D u_weights;
uniform vec3 u_bias;
uniform int u_numInputGroups;
uniform int u_inputGridCols;
uniform ivec2 u_inputCellSize;

out vec4 fragColor;

void main() {
    ivec2 outPos = ivec2(gl_FragCoord.xy);
    int px = outPos.x & 1;
    int py = outPos.y & 1;
    ivec2 baseInput = ivec2((outPos.x - px) / 2, (outPos.y - py) / 2);

    vec3 sum = u_bias;

    for (int dy = 0; dy <= 1; dy++) {
        for (int dx = 0; dx <= 1; dx++) {
            ivec2 inputPos = baseInput - ivec2(dx, dy);

            if (inputPos.x < 0 || inputPos.y < 0 ||
                inputPos.x >= u_inputCellSize.x || inputPos.y >= u_inputCellSize.y)
                continue;

            int kx = px + 2 * dx;
            int ky = py + 2 * dy;

            for (int ig = 0; ig < u_numInputGroups; ig++) {
                int inCellX = ig % u_inputGridCols;
                int inCellY = ig / u_inputGridCols;
                ivec2 inCellOrigin = ivec2(inCellX * u_inputCellSize.x, inCellY * u_inputCellSize.y);
                vec4 inputVal = texelFetch(u_input, inCellOrigin + inputPos, 0);

                int wx = ig * 4 + kx;
                vec4 w0 = texelFetch(u_weights, ivec2(wx, 0 * 4 + ky), 0);
                vec4 w1 = texelFetch(u_weights, ivec2(wx, 1 * 4 + ky), 0);
                vec4 w2 = texelFetch(u_weights, ivec2(wx, 2 * 4 + ky), 0);

                sum.r += dot(inputVal, w0);
                sum.g += dot(inputVal, w1);
                sum.b += dot(inputVal, w2);
            }
        }
    }

    fragColor = vec4(clamp(sum, 0.0, 1.0), 1.0);
}
