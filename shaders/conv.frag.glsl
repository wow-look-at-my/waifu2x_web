#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_input;
uniform sampler2D u_weights;
uniform sampler2D u_biases;
uniform int u_numInputGroups;
uniform int u_numOutputGroups;
uniform int u_inputGridCols;
uniform int u_outputGridCols;
uniform ivec2 u_inputCellSize;
uniform ivec2 u_outputCellSize;

out vec4 fragColor;

void main() {
    ivec2 texelPos = ivec2(gl_FragCoord.xy);
    int outCellX = texelPos.x / u_outputCellSize.x;
    int outCellY = texelPos.y / u_outputCellSize.y;
    int outputGroup = outCellY * u_outputGridCols + outCellX;

    if (outputGroup >= u_numOutputGroups) {
        fragColor = vec4(0.0);
        return;
    }

    ivec2 pos = texelPos - ivec2(outCellX * u_outputCellSize.x, outCellY * u_outputCellSize.y);

    vec4 sum = texelFetch(u_biases, ivec2(outputGroup, 0), 0);

    for (int ig = 0; ig < u_numInputGroups; ig++) {
        int inCellX = ig % u_inputGridCols;
        int inCellY = ig / u_inputGridCols;
        ivec2 inCellOrigin = ivec2(inCellX * u_inputCellSize.x, inCellY * u_inputCellSize.y);

        for (int ky = 0; ky < 3; ky++) {
            for (int kx = 0; kx < 3; kx++) {
                vec4 inputVal = texelFetch(u_input, inCellOrigin + pos + ivec2(kx, ky), 0);

                int wx = ig * 12 + kx * 4;
                int wy = outputGroup * 3 + ky;

                sum.r += dot(inputVal, texelFetch(u_weights, ivec2(wx,     wy), 0));
                sum.g += dot(inputVal, texelFetch(u_weights, ivec2(wx + 1, wy), 0));
                sum.b += dot(inputVal, texelFetch(u_weights, ivec2(wx + 2, wy), 0));
                sum.a += dot(inputVal, texelFetch(u_weights, ivec2(wx + 3, wy), 0));
            }
        }
    }

    fragColor = mix(sum * 0.1, sum, step(0.0, sum));
}
