#include <stdint.h>
#include <stdlib.h>

#define STB_VORBIS_NO_STDIO

#include "stb_vorbis.c"

/*
 * Result layout:
 *
 *   offset  0: int32_t channels
 *   offset  4: int32_t sample_rate
 *   offset  8: int32_t samples_per_channel
 *   offset 12: int16_t pcm[]
 *
 * The returned pointer must be released with vorbis_free()
 */
typedef struct {
    int32_t channels;
    int32_t sample_rate;
    int32_t samples_per_channel;
    int16_t pcm[];
} VorbisResult;

/**
 * stb_vorbis reads the input synchronously for the duration of the call
 * @param data the binary vorbis data
 * @param data_length the length of the binary vorbis data
 *
 * Returns NULL on failure
 */
VorbisResult* vorbis_decode(
    const uint8_t* data,
    int32_t data_length
) {
    int channels = 0;
    int sample_rate = 0;
    int16_t* pcm = NULL;

    // Actual decode call
    int samples = stb_vorbis_decode_memory(
        data,
        data_length,
        &channels,
        &sample_rate,
        &pcm
    );

    // Error checking
    if (samples <= 0 || pcm == NULL || channels <= 0) {
        if (pcm != NULL) {
            free(pcm);
        }

        return NULL;
    }

    // Allocate result
    size_t pcm_bytes =
        (size_t)samples *
        (size_t)channels *
        sizeof(int16_t);

    size_t result_bytes =
        sizeof(VorbisResult) +
        pcm_bytes;

    VorbisResult* result =
        (VorbisResult*)malloc(result_bytes);

    // Error checking
    if (result == NULL) {
        free(pcm);
        return NULL;
    }

    // Copy data
    result->channels = channels;
    result->sample_rate = sample_rate;
    result->samples_per_channel = samples;

    // Copy pcm data
    for (size_t i = 0; i < (size_t)samples * (size_t)channels; ++i) {
        result->pcm[i] = pcm[i];
    }

    // Free and return
    free(pcm);
    return result;
}

/**
 * Frees the VorbisResult pointer
 * @param result the pointer to free
 */
void vorbis_free(VorbisResult* result) {
    free(result);
}
