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
 *   offset 12: float pcm[]
 *
 * The returned pointer must be released with vorbis_free()
 */
typedef struct {
    int32_t channels;
    int32_t sample_rate;
    int32_t samples_per_channel;
    float pcm[];
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
    const int32_t data_length
) {
    int channels = 0;
    int error = 0;
    stb_vorbis* vorbis = stb_vorbis_open_memory(data, data_length, &error, NULL);

    if (vorbis == NULL) {
        return NULL;
    }

    const stb_vorbis_info info = stb_vorbis_get_info(vorbis);
    channels = info.channels;
    int sample_rate = (int)info.sample_rate;

    const int samples_per_chunk = 4096;
    size_t capacity = (size_t)channels * (size_t)samples_per_chunk;
    size_t sample_count = 0;
    float* pcm = malloc(capacity * sizeof(float));

    // Error checking
    if (pcm == NULL || channels <= 0 || sample_rate <= 0) {
        free(pcm);
        stb_vorbis_close(vorbis);
        return NULL;
    }

    for (;;) {
        const size_t available = capacity - sample_count * (size_t)channels;
        const int samples = stb_vorbis_get_samples_float_interleaved(
            vorbis,
            channels,
            pcm + sample_count * (size_t)channels,
            (int)available
        );

        if (samples <= 0) {
            break;
        }

        sample_count += (size_t)samples;

        if (capacity - sample_count * (size_t)channels < (size_t)channels) {
            capacity *= 2;
            float* resized = realloc(
                pcm,
                capacity * sizeof(float)
            );
            if (resized == NULL) {
                free(pcm);
                stb_vorbis_close(vorbis);
                return NULL;
            }
            pcm = resized;
        }
    }

    stb_vorbis_close(vorbis);

    if (sample_count == 0) {
        free(pcm);
        return NULL;
    }

    // Allocate result
    size_t pcm_bytes =
        sample_count *
        (size_t)channels *
        sizeof(float);

    const size_t result_bytes =
        sizeof(VorbisResult) +
        pcm_bytes;

    VorbisResult* result =
        malloc(result_bytes);

    // Error checking
    if (result == NULL) {
        free(pcm);
        return NULL;
    }

    // Copy data
    result->channels = channels;
    result->sample_rate = sample_rate;
    result->samples_per_channel = (int32_t)sample_count;

    // Copy pcm data
    for (size_t i = 0; i < sample_count * (size_t)channels; ++i) {
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
