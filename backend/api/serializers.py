from rest_framework import serializers
from PIL import Image as PILImage
from PIL.ExifTags import TAGS, GPSTAGS
from .models import User, Image


def get_exif_location(file):
    """
    Extract GPS coordinates from image EXIF data.
    Returns (latitude, longitude) or (None, None) if not found.
    """
    try:
        img = PILImage.open(file)
        exif = img._getexif()
        if not exif:
            return None, None
        gps_info = {}
        for tag, value in exif.items():
            decoded = TAGS.get(tag, tag)
            if decoded == "GPSInfo":
                for t in value:
                    sub_decoded = GPSTAGS.get(t, t)
                    gps_info[sub_decoded] = value[t]

        lat = gps_info.get("GPSLatitude")
        lat_ref = gps_info.get("GPSLatitudeRef")
        lon = gps_info.get("GPSLongitude")
        lon_ref = gps_info.get("GPSLongitudeRef")

        if lat and lon and lat_ref and lon_ref:
            # Convert to decimal degrees
            lat = (lat[0] + lat[1] / 60 + lat[2] / 3600) * (1 if lat_ref == 'N' else -1)
            lon = (lon[0] + lon[1] / 60 + lon[2] / 3600) * (1 if lon_ref == 'E' else -1)
            return lat, lon
    except:
        return None, None

    return None, None


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['user_id', 'email', 'phone_number']


class ImageSerializer(serializers.ModelSerializer):
    latitude = serializers.FloatField(required=False, allow_null=True)
    longitude = serializers.FloatField(required=False, allow_null=True)
    azimuth = serializers.FloatField(required=False, allow_null=True)
    file = serializers.ImageField(required=False, allow_null=True)  # ✅ ensure DRF knows about the file
    file_url = serializers.SerializerMethodField()  # ✅ expose full URL for frontend

    class Meta:
        model = Image
        fields = '__all__'

    def get_file_url(self, obj):
        """Return absolute URL for uploaded image."""
        request = self.context.get('request')
        if obj.file and request:
            return request.build_absolute_uri(obj.file.url)
        elif obj.file:
            return obj.file.url
        return None

    def validate(self, data):
        """
        Ensure empty strings or missing fields are converted to None.
        """
        for field in ['latitude', 'longitude', 'azimuth']:
            if field in data and (data[field] == '' or data[field] is None):
                data[field] = None
        return data

    def create(self, validated_data):
        """
        If latitude/longitude are missing, extract from EXIF data.
        """
        file = validated_data.get('file')
        if file:
            lat, lon = get_exif_location(file)
            if validated_data.get('latitude') is None and lat is not None:
                validated_data['latitude'] = lat
            if validated_data.get('longitude') is None and lon is not None:
                validated_data['longitude'] = lon
        return super().create(validated_data)

    def update(self, instance, validated_data):
        """
        Handle updates: preserve EXIF fallback if user did not input lat/lon.
        """
        file = validated_data.get('file', None)
        if file and (validated_data.get('latitude') is None or validated_data.get('longitude') is None):
            lat, lon = get_exif_location(file)
            if validated_data.get('latitude') is None and lat is not None:
                validated_data['latitude'] = lat
            if validated_data.get('longitude') is None and lon is not None:
                validated_data['longitude'] = lon
        return super().update(instance, validated_data)