import yaml

def read_config(config_file_path):
    try:
        with open(config_file_path, 'r') as config_file:
            config_object = yaml.safe_load(config_file)
        return config_object
    except IOError as e:
        print(f"Error while reading config: {e}")
        raise IOError
    except Exception as e:
        print(f"Error while reading config: {e}")
        raise e